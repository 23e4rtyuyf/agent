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
const HOST = '0.0.0.0';

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isMissedCall(callStatus) {
  return ['busy', 'canceled', 'failed', 'no-answer'].includes(String(callStatus || '').toLowerCase());
}

function normalizePhoneNumber(phoneNumber) {
  return String(phoneNumber || '').trim();
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
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  if (!leadsByPhone.has(normalizedPhone)) {
    leadsByPhone.set(normalizedPhone, {
      phoneNumber: normalizedPhone,
      customerName: 'Unknown',
      intent: 'Needs follow-up',
      urgency: 'General Question',
      emergency: false,
      conversationComplete: false,
      leadSummary: 'Missed call captured. Awaiting more details.',
      timestamp: new Date().toISOString(),
      conversationStatus: 'Active',
      lastMessageSent: '',
      history: []
    });
  }

  return leadsByPhone.get(normalizedPhone);
}

function appendHistory(phoneNumber, direction, content, channel = 'sms') {
  if (!content) {
    return;
  }

  const lead = getLead(phoneNumber);
  lead.history.push({
    direction,
    channel,
    content: String(content),
    timestamp: new Date().toISOString()
  });
}

function updateLead(phoneNumber, updates = {}) {
  const lead = getLead(phoneNumber);
  lead.timestamp = new Date().toISOString();
  Object.assign(lead, updates);
  return lead;
}

function hasUrgentSignal(leadPayload, incomingText = '') {
  const urgency = String(leadPayload?.urgency || '').toLowerCase();
  const emergency = Boolean(leadPayload?.emergency);
  const incoming = String(incomingText || '').toLowerCase();
  const keywordMatch = /\b(emergency|urgent|asap|immediately|right now|help now)\b/.test(incoming);

  return emergency || urgency.includes('urgent') || keywordMatch;
}

function summarizeLead(lead) {
  return {
    phoneNumber: lead.phoneNumber,
    customerName: lead.customerName,
    intent: lead.intent,
    urgency: lead.urgency,
    emergency: lead.emergency,
    conversationComplete: lead.conversationComplete,
    leadSummary: lead.leadSummary,
    timestamp: lead.timestamp,
    conversationStatus: lead.conversationStatus,
    lastMessageSent: lead.lastMessageSent,
    historyCount: Array.isArray(lead.history) ? lead.history.length : 0
  };
}

function sortedLeadSummaries() {
  return Array.from(leadsByPhone.values())
    .map((lead) => summarizeLead(lead))
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

function getConversationStatus(leadPayload, incomingText) {
  if (hasUrgentSignal(leadPayload, incomingText)) {
    return 'URGENT';
  }

  if (leadPayload?.conversationComplete) {
    return 'Completed';
  }

  return 'Active';
}

function pickPreferredText(nextValue, currentValue, fallbackValue) {
  const normalizedNextValue = String(nextValue || '').trim();

  if (normalizedNextValue && normalizedNextValue.toLowerCase() !== 'unknown') {
    return normalizedNextValue;
  }

  const normalizedCurrentValue = String(currentValue || '').trim();
  if (normalizedCurrentValue) {
    return normalizedCurrentValue;
  }

  return fallbackValue;
}

function buildLeadUpdates(existingLead, leadPayload, reply, incomingText) {
  const safeLeadPayload = leadPayload && typeof leadPayload === 'object' ? leadPayload : {};

  return {
    customerName: pickPreferredText(safeLeadPayload.name, existingLead.customerName, 'Unknown'),
    intent: pickPreferredText(safeLeadPayload.intent, existingLead.intent, 'Needs follow-up'),
    urgency: pickPreferredText(safeLeadPayload.urgency, existingLead.urgency, 'General Question'),
    emergency: Boolean(safeLeadPayload.emergency || existingLead.emergency),
    conversationComplete: Boolean(existingLead.conversationComplete || safeLeadPayload.conversationComplete),
    leadSummary:
      pickPreferredText(
        safeLeadPayload.summary,
        existingLead.leadSummary,
        'Conversation captured. A team member should follow up.'
      ),
    conversationStatus: getConversationStatus(safeLeadPayload, incomingText),
    lastMessageSent: reply
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'AI missed-call text-back system' });
});

app.post('/webhook/voice', async (req, res) => {
  const { CallStatus, From } = req.body || {};
  const from = normalizePhoneNumber(From);
  const dedupeKey = getVoiceDedupeKey(req.body);

  pruneHandledMissedCalls();

  if (!from || !isMissedCall(CallStatus) || handledMissedCalls.has(dedupeKey)) {
    return res.json({ ok: true, textSent: false });
  }

  handledMissedCalls.set(dedupeKey, Date.now());
  const textSent = await sendMissedCallText(from);

  if (textSent) {
    appendHistory(from, 'assistant', MISSED_CALL_TEXT, 'voice-auto-reply');
  } else {
    appendHistory(from, 'system', 'Missed call captured, but the automatic text could not be sent.', 'voice');
  }

  updateLead(from, {
    conversationStatus: 'Active',
    lastMessageSent: textSent ? MISSED_CALL_TEXT : 'Automatic text could not be sent.',
    leadSummary: textSent
      ? 'Missed call captured and text-back sent automatically.'
      : 'Missed call captured, but the text-back was not sent because Twilio was unavailable.'
  });

  return res.json({ ok: true, textSent });
});

app.post('/webhook/sms', async (req, res) => {
  const from = normalizePhoneNumber(req.body?.From);
  const body = req.body?.Body;

  if (!from) {
    return res.status(400).json({ ok: false, error: 'Missing From number.' });
  }

  appendHistory(from, 'user', body);

  const existingLead = getLead(from);
  const { reply, lead } = await generateReply(from, body);
  const updates = buildLeadUpdates(existingLead, lead, reply, body);

  updateLead(from, updates);
  appendHistory(from, 'assistant', reply);

  const messagingResponse = new twilio.twiml.MessagingResponse();
  messagingResponse.message(reply);

  res.type('text/xml');
  return res.send(messagingResponse.toString());
});

app.get('/api/leads', (_req, res) => {
  return res.json(sortedLeadSummaries());
});

app.post('/api/lead-details', (req, res) => {
  const requestedPhoneNumber = normalizePhoneNumber(req.body?.phoneNumber);

  if (!requestedPhoneNumber) {
    return res.status(400).json({ ok: false, error: 'Missing phone number.' });
  }

  const lead = leadsByPhone.get(requestedPhoneNumber);

  if (!lead) {
    return res.status(404).json({ ok: false, error: 'Lead not found.' });
  }

  return res.json({
    ...summarizeLead(lead),
    history: lead.history
  });
});

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '', 10) || 3000;

  app.listen(port, HOST, () => {
    console.log(`Server listening on http://${HOST}:${port}`);
  });
}

module.exports = {
  app,
  isMissedCall,
  leadsByPhone,
  normalizePhoneNumber
};
