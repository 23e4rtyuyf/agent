require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { generateAssistantReply } = require('./ai');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  PORT
} = process.env;

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Replit: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, OPENAI_API_KEY in the Secrets panel.
const conversations = new Map();

const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);
const INITIAL_TEXT = 'Hi! Sorry we missed your call. How can we help you today?';

function getHistory(phoneNumber) {
  if (!conversations.has(phoneNumber)) {
    conversations.set(phoneNumber, []);
  }
  return conversations.get(phoneNumber);
}

async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_NUMBER) {
    console.warn('Twilio client or TWILIO_NUMBER missing. SMS send skipped.', { to, body });
    return;
  }

  await twilioClient.messages.create({
    from: TWILIO_NUMBER,
    to,
    body
  });
}

app.post('/webhook/voice', async (req, res) => {
  const from = req.body.From;
  const callStatus = (req.body.CallStatus || '').toLowerCase();

  if (!from) {
    return res.status(400).json({ error: 'Missing caller number (From).' });
  }

  if (MISSED_STATUSES.has(callStatus)) {
    try {
      await sendSms(from, INITIAL_TEXT);
      getHistory(from);
    } catch (error) {
      console.error('Failed to send missed-call text-back:', error.message);
      return res.status(500).json({ error: 'Failed to send text-back.' });
    }
  }

  return res.status(200).json({ ok: true, callStatus });
});

app.post('/webhook/sms', async (req, res) => {
  const from = req.body.From;
  const incomingBody = (req.body.Body || '').trim();

  if (!from || !incomingBody) {
    return res.status(400).json({ error: 'Missing From or Body in inbound SMS webhook.' });
  }

  const history = getHistory(from);
  history.push({ role: 'user', content: incomingBody });

  try {
    const aiResult = await generateAssistantReply({
      phoneNumber: from,
      inboundText: incomingBody,
      history
    });

    history.push({ role: 'assistant', content: aiResult.assistantMessage });

    await sendSms(from, aiResult.assistantMessage);

    return res.status(200).json({
      ok: true,
      lead: aiResult.extraction
    });
  } catch (error) {
    console.error('AI/SMS processing error:', error.message);
    return res.status(500).json({ error: 'Failed to process SMS message.' });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT || 3000}`);
});
