require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const { generateReply } = require('./ai');

const app = express();
const handledMissedCalls = new Map();

const MISSED_CALL_TEXT = 'Hi! Sorry we missed your call. How can we help you today?';
const MISSED_CALL_TTL_MS = 6 * 60 * 60 * 1000;

// Add these values in Replit using the Secrets panel:
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, OPENAI_API_KEY

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

  await client.messages.create({
    body: MISSED_CALL_TEXT,
    from: process.env.TWILIO_NUMBER,
    to
  });

  return true;
}

function pruneHandledMissedCalls() {
  const now = Date.now();

  for (const [key, createdAt] of handledMissedCalls.entries()) {
    if (now - createdAt > MISSED_CALL_TTL_MS) {
      handledMissedCalls.delete(key);
    }
  }
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'AI missed-call text-back system' });
});

app.post('/webhook/voice', async (req, res) => {
  const { CallSid, CallStatus, From } = req.body || {};
  const dedupeKey = CallSid || `${From}:${CallStatus}`;

  pruneHandledMissedCalls();

  if (!From || !isMissedCall(CallStatus) || handledMissedCalls.has(dedupeKey)) {
    return res.json({ ok: true, textSent: false });
  }

  handledMissedCalls.set(dedupeKey, Date.now());

  try {
    const textSent = await sendMissedCallText(From);
    return res.json({ ok: true, textSent });
  } catch (error) {
    handledMissedCalls.delete(dedupeKey);
    console.error('Failed to send missed-call text:', error);
    return res.status(500).json({ ok: false, textSent: false });
  }
});

app.post('/webhook/sms', async (req, res) => {
  const from = req.body?.From;
  const body = req.body?.Body;

  if (!from) {
    return res.status(400).json({ ok: false, error: 'Missing From number.' });
  }

  try {
    const { reply, lead } = await generateReply(from, body);

    if (lead?.conversationComplete) {
      console.log('Qualified lead:', JSON.stringify({ phoneNumber: from, lead }));
    }

    const messagingResponse = new twilio.twiml.MessagingResponse();
    messagingResponse.message(reply);

    res.type('text/xml');
    return res.send(messagingResponse.toString());
  } catch (error) {
    console.error('Failed to process SMS webhook:', error);

    const messagingResponse = new twilio.twiml.MessagingResponse();
    messagingResponse.message('Thanks for texting us. We had a temporary issue, but a team member will follow up shortly.');

    res.type('text/xml');
    return res.send(messagingResponse.toString());
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

module.exports = {
  app,
  isMissedCall
};
