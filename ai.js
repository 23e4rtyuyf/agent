const OpenAI = require('openai');

const systemPrompt = `You are a helpful, polite assistant for a local San Diego business handling inbound text leads.
Your goals:
1) Help the customer quickly and clearly.
2) Gather missing details naturally.
3) Extract the customer's name when possible.
4) Identify intent (service request, booking, question, other).
5) Detect emergency urgency (safety risk, immediate damage, urgent same-day need).

Rules:
- Keep responses short, warm, and professional.
- Never invent business policies, prices, or availability.
- If details are missing, ask a concise follow-up question.
- If emergency urgency is detected, advise immediate phone contact and mark as urgent.
- When enough information has been collected to hand off to staff, call the finalize_lead tool.
`;

const finalizeLeadTool = {
  type: 'function',
  function: {
    name: 'finalize_lead',
    description:
      'Call this when enough details are collected to classify the lead for staff follow-up.',
    parameters: {
      type: 'object',
      properties: {
        conversationComplete: {
          type: 'boolean',
          description: 'True when staff has enough details for follow-up.'
        },
        urgency: {
          type: 'string',
          enum: ['Urgent', 'Routine Booking', 'General Inquiry'],
          description: 'Lead urgency/category.'
        },
        customerName: {
          type: 'string',
          description: 'Customer name if provided, otherwise "Unknown".'
        },
        intent: {
          type: 'string',
          description: 'Short summary of what the customer needs.'
        }
      },
      required: ['conversationComplete', 'urgency', 'customerName', 'intent'],
      additionalProperties: false
    }
  }
};

const openaiApiKey = process.env.OPENAI_API_KEY;
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

function normalizeHistory(history = []) {
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
}

function safeParseJson(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function generateAssistantReply({ phoneNumber, inboundText, history = [] }) {
  if (!openai) {
    return {
      assistantMessage:
        'Thanks for your message. Our team will follow up with you shortly.',
      extraction: {
        conversationComplete: false,
        urgency: 'General Inquiry',
        customerName: 'Unknown',
        intent: inboundText || 'Unknown'
      }
    };
  }

  const baseMessages = [
    { role: 'system', content: systemPrompt },
    ...normalizeHistory(history),
    {
      role: 'user',
      content: `Phone: ${phoneNumber}\nLatest message: ${inboundText}`
    }
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: baseMessages,
    temperature: 0.3,
    tools: [finalizeLeadTool]
  });

  const choice = completion.choices?.[0]?.message || {};
  const toolCalls = choice.tool_calls || [];

  let extraction = {
    conversationComplete: false,
    urgency: 'General Inquiry',
    customerName: 'Unknown',
    intent: inboundText || 'Unknown'
  };

  for (const toolCall of toolCalls) {
    if (toolCall.type === 'function' && toolCall.function?.name === 'finalize_lead') {
      const parsed = safeParseJson(toolCall.function.arguments || '{}');
      if (parsed) {
        extraction = {
          ...extraction,
          ...parsed
        };
      }
    }
  }

  let assistantMessage = '';
  if (typeof choice.content === 'string') {
    assistantMessage = choice.content.trim();
  }

  if (!assistantMessage) {
    const followUp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        ...baseMessages,
        choice,
        {
          role: 'tool',
          tool_call_id: toolCalls[0]?.id || 'finalize-lead',
          content: JSON.stringify(extraction)
        },
        {
          role: 'user',
          content:
            'Now send a concise SMS-ready reply to the customer based on this conversation.'
        }
      ]
    });

    assistantMessage =
      followUp.choices?.[0]?.message?.content?.trim() ||
      'Thanks for the details. Our team will contact you soon.';
  }

  return {
    assistantMessage,
    extraction
  };
}

module.exports = {
  generateAssistantReply
};
