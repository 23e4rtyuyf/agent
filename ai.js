const { OpenAI } = require('openai');
const { MAX_MESSAGES_PER_CONVERSATION } = require('./constants');

const conversationStore = new Map();
const conversationTouchedAt = new Map();
const lastModelCallAtByPhone = new Map();

const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 1000;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.OPENAI_MAX_TOKENS || '220', 10);
const MODEL_COOLDOWN_MS = Number.parseInt(process.env.OPENAI_MODEL_COOLDOWN_MS || '45000', 10);
const CREDIT_MODE = String(process.env.AI_CREDITS_MODE || 'balanced').toLowerCase();

const SYSTEM_PROMPT = `
You are a polite, concise SMS assistant for a local service business.
Your job is to help after a missed call, keep the conversation friendly, and gather:
1. the customer's name
2. what they need help with
3. whether the situation is urgent
4. a short summary for the business owner

Rules:
- Keep replies brief and natural for SMS.
- If the customer has not shared their name yet, ask for it naturally.
- Identify the customer's intent in plain language.
- If the user describes an emergency or immediate safety risk, tell them to call 911 right away.
- Do not claim an appointment is confirmed unless a human has actually confirmed it.
- When you have enough information to summarize the lead, call the finalize_lead tool.
`.trim();

const LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'finalize_lead',
    description: 'Summarize the lead once enough information is available or urgency is clear.',
    parameters: {
      type: 'object',
      properties: {
        conversationComplete: {
          type: 'boolean',
          description: 'True when you have enough detail for a human follow-up.'
        },
        name: {
          type: 'string',
          description: 'Customer name if known, otherwise Unknown.'
        },
        intent: {
          type: 'string',
          description: 'Short description of what the customer wants.'
        },
        urgency: {
          type: 'string',
          enum: ['Urgent', 'Routine Booking', 'General Question']
        },
        emergency: {
          type: 'boolean',
          description: 'True if the message indicates an emergency or immediate safety issue.'
        },
        summary: {
          type: 'string',
          description: 'Brief lead summary for the business.'
        }
      },
      required: ['conversationComplete', 'name', 'intent', 'urgency', 'emergency', 'summary']
    }
  }
};

function getConversation(phoneNumber) {
  pruneConversations();

  if (!conversationStore.has(phoneNumber)) {
    conversationStore.set(phoneNumber, []);
  }

  conversationTouchedAt.set(phoneNumber, Date.now());
  return conversationStore.get(phoneNumber);
}

function appendMessage(phoneNumber, role, content) {
  if (!content) {
    return;
  }

  const messages = getConversation(phoneNumber);
  messages.push({ role, content: String(content) });

  if (messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    messages.splice(0, messages.length - MAX_MESSAGES_PER_CONVERSATION);
  }
}

function pruneConversations() {
  const now = Date.now();

  for (const [phoneNumber, lastTouchedAt] of conversationTouchedAt.entries()) {
    if (now - lastTouchedAt > CONVERSATION_TTL_MS) {
      conversationTouchedAt.delete(phoneNumber);
      conversationStore.delete(phoneNumber);
    }
  }

  while (conversationStore.size > MAX_CONVERSATIONS) {
    const oldestPhoneNumber = getOldestConversationPhoneNumber();

    if (!oldestPhoneNumber) {
      break;
    }

    conversationTouchedAt.delete(oldestPhoneNumber);
    conversationStore.delete(oldestPhoneNumber);
  }
}

function getOldestConversationPhoneNumber() {
  let oldestPhoneNumber = null;
  let oldestTouchedAt = Number.POSITIVE_INFINITY;

  for (const [phoneNumber, lastTouchedAt] of conversationTouchedAt.entries()) {
    if (lastTouchedAt < oldestTouchedAt) {
      oldestPhoneNumber = phoneNumber;
      oldestTouchedAt = lastTouchedAt;
    }
  }

  return oldestPhoneNumber;
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  function classifyUrgency(text) {
    if (/\b(emergency|urgent|asap|immediately|right now|leak|fire|flood|unsafe)\b/.test(text)) {
      return { urgency: 'Urgent', emergency: true };
    }

    if (/\b(book|quote|estimate|appointment|schedule|tomorrow|next week)\b/.test(text)) {
      return { urgency: 'Routine Booking', emergency: false };
    }

    return { urgency: 'General Question', emergency: false };
  }

  function inferIntent(text) {
    if (/\b(install|installation)\b/.test(text)) return 'Installation request';
    if (/\b(repair|fix|broken|not working)\b/.test(text)) return 'Repair request';
    if (/\b(quote|price|cost|estimate)\b/.test(text)) return 'Pricing request';
    if (/\b(schedule|appointment|availability)\b/.test(text)) return 'Scheduling request';
    return 'Needs follow-up';
  }

  function buildRuleBasedLead(inboundText) {
    const normalized = inboundText.toLowerCase();
    const { urgency, emergency } = classifyUrgency(normalized);
    const intent = inferIntent(normalized);
    const hasEnoughDetail = /\b(my name is|this is|i need|can you|help with)\b/.test(normalized) || normalized.length > 65;

    return {
      conversationComplete: Boolean(hasEnoughDetail && intent !== 'Needs follow-up'),
      name: 'Unknown',
      intent,
      urgency,
      emergency,
      summary: hasEnoughDetail
        ? `Customer sent ${urgency.toLowerCase()} ${intent.toLowerCase()} details and should receive human follow-up.`
        : 'Customer reached out and needs follow-up questions for full qualification.'
    };
  }

  function buildRuleBasedReply(inboundText, lead) {
    const normalized = inboundText.toLowerCase();

    if (lead.emergency) {
      return 'Thanks for the update — if anyone is in immediate danger, please call 911 now. We will prioritize your message right away.';
    }

    if (/^(ok|k|thanks|thank you|got it|sounds good)[.! ]*$/i.test(normalized)) {
      return 'Perfect, thanks for confirming. A team member will follow up shortly.';
    }

    if (lead.intent === 'Pricing request') {
      return 'Thanks for reaching out. We can help with that quote — can you share the main issue and your preferred timing?';
    }

    if (lead.intent === 'Scheduling request') {
      return 'Got it — what day/time works best, and what service do you need?';
    }

    return 'Thanks for texting us. Could you share your name and a quick summary of what you need help with?';
  }

  function shouldUseRuleBasedPath(phoneNumber, inboundText) {
    const normalized = String(inboundText || '').toLowerCase();
    const lastModelCallAt = lastModelCallAtByPhone.get(phoneNumber) || 0;
    const inCooldown = Date.now() - lastModelCallAt < MODEL_COOLDOWN_MS;
    const shortAck = /^(ok|k|thanks|thank you|got it|yes|no|yep|nope)[.! ]*$/i.test(normalized);
    const lowCreditMode = CREDIT_MODE === 'low';

    return shortAck || (lowCreditMode && normalized.length < 160 && inCooldown);
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function parseLead(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return null;
  }

  for (const toolCall of toolCalls) {
    if (toolCall?.function?.name !== 'finalize_lead') {
      continue;
    }

    try {
      return JSON.parse(toolCall.function.arguments || '{}');
    } catch (error) {
      console.error('Failed to parse lead payload:', error);
    }
  }

  return null;
}

async function generateReply(phoneNumber, incomingMessage) {
  const inboundText = String(incomingMessage || '').trim();

  if (!inboundText) {
    const emptyMessageReply = 'Hi! Thanks for reaching out. How can we help you today?';
    appendMessage(phoneNumber, 'assistant', emptyMessageReply);
    return { reply: emptyMessageReply, lead: null };
  }

  appendMessage(phoneNumber, 'user', inboundText);

  if (shouldUseRuleBasedPath(phoneNumber, inboundText)) {
    const lead = buildRuleBasedLead(inboundText);
    const reply = buildRuleBasedReply(inboundText, lead);
    appendMessage(phoneNumber, 'assistant', reply);
    return { reply, lead };
  }

  const client = getOpenAIClient();

  if (!client) {
    const fallbackReply = 'Thanks for texting us. We received your message and a team member will follow up shortly.';

    appendMessage(phoneNumber, 'assistant', fallbackReply);
    return {
      reply: fallbackReply,
      lead: {
        conversationComplete: false,
        name: 'Unknown',
        intent: 'Needs follow-up',
        urgency: 'General Question',
        emergency: false,
        summary: 'Conversation captured without AI enrichment yet.'
      }
    };
  }

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: CREDIT_MODE === 'low' ? 0.1 : 0.25,
      max_tokens: Number.isFinite(DEFAULT_MAX_TOKENS) ? DEFAULT_MAX_TOKENS : 220,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...getConversation(phoneNumber)
      ],
      tools: [LEAD_TOOL],
      tool_choice: 'auto'
    });

    const assistantMessage = completion.choices?.[0]?.message || {};
    const reply = typeof assistantMessage.content === 'string' && assistantMessage.content.trim()
      ? assistantMessage.content.trim()
      : 'Thanks for the details. A team member will review this and follow up shortly.';
    const lead = parseLead(assistantMessage.tool_calls);

    appendMessage(phoneNumber, 'assistant', reply);
    lastModelCallAtByPhone.set(phoneNumber, Date.now());

    return { reply, lead };
  } catch (error) {
    console.error('OpenAI API call failed:', error);
    const fallbackReply = 'Thanks for texting us. We had a temporary issue, but a team member will follow up shortly.';
    appendMessage(phoneNumber, 'assistant', fallbackReply);
    return {
      reply: fallbackReply,
      lead: {
        conversationComplete: false,
        name: 'Unknown',
        intent: 'Needs follow-up',
        urgency: 'General Question',
        emergency: false,
        summary: 'Temporary AI issue. Human follow-up is recommended.'
      }
    };
  }
}

module.exports = {
  conversationStore,
  generateReply
};
