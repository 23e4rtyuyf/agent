require('dotenv').config();

const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { generateReply } = require('./ai');

const app = express();
const handledMissedCalls = new Map();
const leadsByPhone = new Map();

const MISSED_CALL_TEXT = 'Hi! Sorry we missed your call. How can we help you today?';
const MISSED_CALL_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

// Add these values in Replit using the Secrets panel:
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, OPENAI_API_KEY

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isMissedCall(callStatus) {
  return ['busy', 'canceled', 'failed', 'no-answer'].includes(String(callStatus || '').toLowerCase());
}

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
    return null;
  }

  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendMissedCallText(to) {
  const client = getTwilioClient();

  if (!client || !to) {
    return false;
  }

  try {
    await client.messages.create({
      body: MISSED_CALL_TEXT,
      from: process.env.TWILIO_NUMBER,
      to
    });
  } catch (error) {
    console.error('Twilio dispatch failed:', error);
    return false;
  }

  return true;
}

function getLead(phoneNumber) {
  if (!leadsByPhone.has(phoneNumber)) {
    leadsByPhone.set(phoneNumber, {
      phoneNumber,
      timestamp: new Date().toISOString(),
      conversationStatus: 'Active',
      lastMessageSent: '',
      history: []
    });
  }

  return leadsByPhone.get(phoneNumber);
}

function appendHistory(phoneNumber, direction, content) {
  if (!content) {
    return;
  }

  const lead = getLead(phoneNumber);
  lead.history.push({
    direction,
    content: String(content),
    timestamp: new Date().toISOString()
  });
}

function updateLead(phoneNumber, updates = {}) {
  const lead = getLead(phoneNumber);
  lead.timestamp = new Date().toISOString();
  Object.assign(lead, updates);
}

function hasUrgentSignal(leadPayload, incomingText = '') {
  const urgency = String(leadPayload?.urgency || '').toLowerCase();
  const emergency = Boolean(leadPayload?.emergency);
  const incoming = String(incomingText || '').toLowerCase();
  const keywordMatch = /\b(emergency|urgent|asap|immediately|right now|help now)\b/.test(incoming);

  return emergency || urgency.includes('urgent') || keywordMatch;
}

function sortedLeadSummaries() {
  return Array.from(leadsByPhone.values())
    .map(({ phoneNumber, timestamp, conversationStatus, lastMessageSent }) => ({
      phoneNumber,
      timestamp,
      conversationStatus,
      lastMessageSent
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function pruneHandledMissedCalls() {
  const now = Date.now();

  for (const [key, createdAt] of handledMissedCalls.entries()) {
    if (now - createdAt > MISSED_CALL_TTL_MS) {
      handledMissedCalls.delete(key);
    }
  }
}

function getVoiceDedupeKey(payload) {
  if (payload?.CallSid) {
    return payload.CallSid;
  }

  const timeBucket = Math.floor(Date.now() / FALLBACK_DEDUPE_WINDOW_MS);
  return `fallback:${payload?.From || 'unknown'}:${payload?.CallStatus || 'unknown'}:${timeBucket}`;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'AI missed-call text-back system' });
});

app.post('/webhook/voice', async (req, res) => {
  const { CallStatus, From } = req.body || {};
  const dedupeKey = getVoiceDedupeKey(req.body);

  pruneHandledMissedCalls();

  if (!From || !isMissedCall(CallStatus) || handledMissedCalls.has(dedupeKey)) {
    return res.json({ ok: true, textSent: false });
  }

  handledMissedCalls.set(dedupeKey, Date.now());
  const textSent = await sendMissedCallText(From);
  appendHistory(From, 'assistant', MISSED_CALL_TEXT);
  updateLead(From, {
    conversationStatus: 'Active',
    lastMessageSent: MISSED_CALL_TEXT
  });
  return res.json({ ok: true, textSent });
});

app.post('/webhook/sms', async (req, res) => {
  const from = req.body?.From;
  const body = req.body?.Body;

  if (!from) {
    return res.status(400).json({ ok: false, error: 'Missing From number.' });
  }

  appendHistory(from, 'user', body);

  const { reply, lead } = await generateReply(from, body);
  const urgent = hasUrgentSignal(lead, body);
  const conversationStatus = urgent
    ? 'URGENT'
    : (lead?.conversationComplete ? 'Completed' : 'Active');

  updateLead(from, {
    conversationStatus,
    lastMessageSent: reply
  });
  appendHistory(from, 'assistant', reply);

  const messagingResponse = new twilio.twiml.MessagingResponse();
  messagingResponse.message(reply);

  res.type('text/xml');
  return res.send(messagingResponse.toString());
});

app.get('/api/leads', (_req, res) => {
  return res.json(sortedLeadSummaries());
});

app.get('/api/leads/:phoneNumber', (req, res) => {
  const requestedPhoneNumber = decodeURIComponent(req.params.phoneNumber || '');
  const lead = leadsByPhone.get(requestedPhoneNumber);

  if (!lead) {
    return res.status(404).json({ ok: false, error: 'Lead not found.' });
  }

  return res.json({
    phoneNumber: lead.phoneNumber,
    timestamp: lead.timestamp,
    conversationStatus: lead.conversationStatus,
    lastMessageSent: lead.lastMessageSent,
    history: lead.history
  });
});

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  app,
  isMissedCall,
  leadsByPhone
};
