# AI Missed-Call Text-Back & Lead Qualification System

A Node.js webhook service for Twilio Voice/SMS that instantly texts missed callers and uses OpenAI to qualify leads.

## Files

- `index.js` – Express webhook server (`/webhook/voice`, `/webhook/sms`)
- `ai.js` – OpenAI prompt + structured lead extraction
- `package.json` – dependencies + start script for Replit

## Replit Setup

1. Import this GitHub repo into Replit.
2. In Replit **Secrets**, add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_NUMBER`
   - `OPENAI_API_KEY`
3. Replit runs with:
   - `npm install`
   - `npm start`
4. The app binds to `0.0.0.0` and `process.env.PORT || 3000` for public Replit URL support.

## Twilio Webhook Configuration

After Replit starts, copy your Replit public URL and configure in Twilio:

- **Phone Number → Voice webhook (A call comes in):**
  - Method: `POST`
  - URL: `https://<your-replit-url>/webhook/voice`

- **Phone Number → Messaging webhook (A message comes in):**
  - Method: `POST`
  - URL: `https://<your-replit-url>/webhook/sms`

## Behavior

- Missed/unanswered call statuses (`no-answer`, `busy`, `failed`, `canceled`) trigger:
  - `Hi! Sorry we missed your call. How can we help you today?`
- Incoming SMS messages are sent to OpenAI.
- AI returns both:
  - Customer-facing response SMS
  - Structured lead payload (`conversationComplete`, `urgency`, `customerName`, `intent`)
