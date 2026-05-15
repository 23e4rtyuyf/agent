require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const { MAX_MESSAGES_PER_CONVERSATION } = require('./constants');

const app = express();
const handledMissedCalls = new Map();
const conversations = new Map();

const MISSED_CALL_TEXT = 'Hi! Sorry we missed your call. How can we help you today?';
const MISSED_CALL_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

// Add these values in Replit using the Secrets panel:
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, OPENAI_API_KEY

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const SYSTEM_PROMPT = `
You are a helpful, polite assistant for a local San Diego business.
Keep replies concise for SMS. Ask clarifying questions when needed.
Collect name, intent, and urgency level. If there is an emergency,
ask the customer to call 911 immediately.
`.trim();

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

function getConversation(phoneNumber) {
  if (!conversations.has(phoneNumber)) {
    conversations.set(phoneNumber, []);
  }

  return conversations.get(phoneNumber);
}

function appendConversation(phoneNumber, role, content) {
  if (!content) {
    return;
  }

  const messages = getConversation(phoneNumber);
  messages.push({ role, content });

  if (messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    messages.splice(0, messages.length - MAX_MESSAGES_PER_CONVERSATION);
  }
}

async function getAiReply(phoneNumber, incomingMessage) {
  const normalizedMessage = String(incomingMessage || '').trim();
  const fallbackReply = normalizedMessage
    ? 'Thanks for texting us. We received your message and a team member will follow up shortly.'
    : 'Hi! Thanks for reaching out. How can we help you today?';

  if (!openai) {
    return fallbackReply;
  }

  if (normalizedMessage) {
    appendConversation(phoneNumber, 'user', normalizedMessage);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...getConversation(phoneNumber)
      ]
    });

    const aiReply = completion.choices[0].message.content;
    const replyText = typeof aiReply === 'string' && aiReply.trim() ? aiReply.trim() : fallbackReply;
    appendConversation(phoneNumber, 'assistant', replyText);
    return replyText;
  } catch (error) {
    console.error('OpenAI API call failed:', error);
    return fallbackReply;
  }
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

app.get('/', (_req, res) => {
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
  return res.json({ ok: true, textSent });
});

app.post('/webhook/sms', async (req, res) => {
  const from = req.body?.From;
  const body = req.body?.Body;

  if (!from) {
    return res.status(400).json({ ok: false, error: 'Missing From number.' });
  }

  const reply = await getAiReply(from, body);
  const messagingResponse = new twilio.twiml.MessagingResponse();
  messagingResponse.message(reply);

  res.type('text/xml');
  return res.send(messagingResponse.toString());
});

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  app,
  isMissedCall
};
