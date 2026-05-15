const OpenAI = require('openai');

const conversationStore = new Map();
const conversationTouchedAt = new Map();

const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 1000;

const SYSTEM_PROMPT = `
You are a polite, concise SMS assistant for a local San Diego business.
Your job is to help after a missed call, keep the conversation friendly, and gather:
1. the customer's name
2. what they need help with
3. whether the situation is urgent

Rules:
- Keep replies brief and natural for SMS.
- If the customer has not shared their name yet, ask for it naturally.
- Identify the user's intent in plain language.
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
  messages.push({ role, content });

  if (messages.length > 20) {
    messages.splice(0, messages.length - 20);
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

  const client = getOpenAIClient();

  if (!client) {
    const fallbackReply = 'Thanks for texting us. We received your message and a team member will follow up shortly.';

    appendMessage(phoneNumber, 'assistant', fallbackReply);
    return { reply: fallbackReply, lead: null };
  }

  try {
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.4,
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

    return { reply, lead };
  } catch (error) {
    console.error('OpenAI API call failed:', error);
    const fallbackReply = 'Thanks for texting us. We had a temporary issue, but a team member will follow up shortly.';
    appendMessage(phoneNumber, 'assistant', fallbackReply);
    return { reply: fallbackReply, lead: null };
  }
}

module.exports = {
  conversationStore,
  generateReply
};
