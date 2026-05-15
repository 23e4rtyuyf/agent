const express = require('express');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const DATA_FILE = path.join(__dirname, 'index.json');
const TEMP_DATA_FILE = path.join(__dirname, 'index.json.tmp');
const VALID_INTENTS = ['Booking', 'Inquiry', 'Maintenance Emergency'];
const VALID_URGENCY_LEVELS = ['Routine', 'URGENT'];
const SAFE_PHONE_REGEX = /^\+?\d{7,15}$/;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const normalizePhone = (raw) => String(raw || '').replace(/[^\d]/g, '');
const isSafePhoneKey = (phone) => SAFE_PHONE_REGEX.test(phone);

function createEmptyStore() {
  return { leads: Object.create(null) };
}

function sanitizeLeads(rawLeads) {
  const safeLeads = Object.create(null);
  for (const [key, lead] of Object.entries(rawLeads || {})) {
    if (!isSafePhoneKey(key) || !lead || typeof lead !== 'object') continue;
    safeLeads[key] = {
      phone: key,
      status: lead.status === 'URGENT' ? 'URGENT' : 'Routine',
      client_name: typeof lead.client_name === 'string' ? lead.client_name : '',
      intent: VALID_INTENTS.includes(lead.intent) ? lead.intent : 'Inquiry',
      urgency_level: lead.urgency_level === 'URGENT' ? 'URGENT' : 'Routine',
      missed_calls: Number.isFinite(lead.missed_calls) ? Math.max(0, lead.missed_calls) : 0,
      active: Boolean(lead.active),
      messages: Array.isArray(lead.messages)
        ? lead.messages
            .filter((msg) => msg && typeof msg === 'object')
            .map((msg) => ({
              role: ['user', 'assistant', 'system'].includes(msg.role) ? msg.role : 'system',
              text: typeof msg.text === 'string' ? msg.text : '',
              at: typeof msg.at === 'string' ? msg.at : new Date().toISOString()
            }))
        : [],
      updated_at: typeof lead.updated_at === 'string' ? lead.updated_at : new Date().toISOString()
    };
  }
  return safeLeads;
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const initial = createEmptyStore();
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.leads || typeof parsed.leads !== 'object') {
      return createEmptyStore();
    }
    return { leads: sanitizeLeads(parsed.leads) };
  } catch (error) {
    const fallbackName = `index.corrupt.${Date.now()}.json`;
    const fallbackPath = path.join(__dirname, fallbackName);
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, fallbackPath);
    }
    console.error(`Failed to load ${DATA_FILE}. Backup written to ${fallbackPath}.`, error);
    return createEmptyStore();
  }
}

function saveStore(store) {
  const safeData = JSON.stringify(store, null, 2);
  fs.writeFileSync(TEMP_DATA_FILE, safeData, 'utf8');
  fs.renameSync(TEMP_DATA_FILE, DATA_FILE);
}

let store = loadStore();

function ensureLead(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error('A valid phone number is required.');
  }
  const safePhone = `+${normalized}`;
  if (!isSafePhoneKey(safePhone)) {
    throw new Error('A valid phone number is required.');
  }

  if (!Object.prototype.hasOwnProperty.call(store.leads, safePhone)) {
    store.leads[safePhone] = {
      phone: safePhone,
      status: 'Routine',
      client_name: '',
      intent: 'Inquiry',
      urgency_level: 'Routine',
      missed_calls: 0,
      active: true,
      messages: [],
      updated_at: new Date().toISOString()
    };
  }

  return store.leads[safePhone];
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'update_lead_metadata',
      description: 'Extract lead metadata from conversation as strict structured data.',
      parameters: {
        type: 'object',
        properties: {
          client_name: {
            type: 'string',
            description: 'Best known client name or empty string if unknown.'
          },
          intent: {
            type: 'string',
            enum: VALID_INTENTS
          },
          urgency_level: {
            type: 'string',
            enum: VALID_URGENCY_LEVELS
          }
        },
        required: ['client_name', 'intent', 'urgency_level']
      }
    }
  }
];

async function generateAiReplyAndMetadata(lead, inboundMessage) {
  if (!openai) {
    return {
      reply: 'Thanks for reaching out. We received your message and will respond shortly.',
      metadata: null
    };
  }

  const history = lead.messages.slice(-10).map((entry) => ({
    role: entry.role,
    content: entry.text
  }));

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are an SMS lead assistant. Reply helpfully and use function calling to classify metadata using update_lead_metadata.'
      },
      ...history,
      { role: 'user', content: inboundMessage }
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0.3
  });

  const message = completion.choices[0]?.message || {};
  const reply = message.content || 'Thanks for your message. Our team will follow up soon.';

  let metadata = null;
  for (const toolCall of message.tool_calls || []) {
    if (toolCall?.function?.name !== 'update_lead_metadata') continue;
    try {
      const parsed = JSON.parse(toolCall.function.arguments || '{}');
      metadata = {
        client_name: typeof parsed.client_name === 'string' ? parsed.client_name.trim() : '',
        intent: VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'Inquiry',
        urgency_level: parsed.urgency_level === 'URGENT' ? 'URGENT' : 'Routine'
      };
    } catch (error) {
      console.error('Failed to parse update_lead_metadata tool arguments.', error);
      metadata = null;
    }
  }

  return { reply, metadata };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/leads', (_req, res) => {
  const leads = Object.values(store.leads)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .map((lead) => ({
      phone: lead.phone,
      status: lead.status,
      client_name: lead.client_name,
      intent: lead.intent,
      urgency_level: lead.urgency_level,
      missed_calls: lead.missed_calls,
      active: lead.active,
      updated_at: lead.updated_at,
      messages: lead.messages
    }));

  const summary = {
    total_missed_calls: leads.reduce((sum, lead) => sum + (lead.missed_calls || 0), 0),
    active_conversations: leads.filter((lead) => lead.active).length
  };

  res.json({ summary, leads });
});

app.post('/api/inbound', async (req, res) => {
  const { phone, type = 'sms', message = '' } = req.body || {};

  let lead;
  try {
    lead = ensureLead(phone);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  lead.active = true;
  lead.updated_at = new Date().toISOString();

  if (type === 'missed_call') {
    lead.missed_calls += 1;
    lead.messages.push({
      role: 'system',
      text: 'Missed call detected.',
      at: new Date().toISOString()
    });
    saveStore(store);
    return res.json({ ok: true, lead });
  }

  if (message) {
    lead.messages.push({
      role: 'user',
      text: String(message),
      at: new Date().toISOString()
    });
  }

  try {
    const { reply, metadata } = await generateAiReplyAndMetadata(lead, String(message || ''));

    if (metadata) {
      lead.client_name = metadata.client_name;
      lead.intent = metadata.intent;
      lead.urgency_level = metadata.urgency_level;
      lead.status = metadata.urgency_level === 'URGENT' ? 'URGENT' : 'Routine';
    }

    lead.messages.push({
      role: 'assistant',
      text: reply,
      at: new Date().toISOString()
    });
  } catch (error) {
    console.error('OpenAI response generation failed.', error);
    lead.messages.push({
      role: 'assistant',
      text: 'Thanks for contacting us. Our team will follow up shortly.',
      at: new Date().toISOString()
    });
  }

  lead.updated_at = new Date().toISOString();
  saveStore(store);

  return res.json({ ok: true, lead });
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
