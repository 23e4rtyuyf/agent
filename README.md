# AI Missed-Call Text-Back & Lead Qualification System

This project is a Replit-ready Node.js service that:

- receives Twilio voice webhooks for missed calls
- sends an instant text-back
- continues the SMS conversation
- uses OpenAI to qualify the lead and flag urgency

## Files

- `/home/runner/work/reimagined-enigma/reimagined-enigma/index.js` - Express webhook server
- `/home/runner/work/reimagined-enigma/reimagined-enigma/ai.js` - OpenAI prompt, conversation state, and structured lead extraction
- `/home/runner/work/reimagined-enigma/reimagined-enigma/package.json` - dependencies and Replit start script

## Replit setup

1. Import this repository into Replit.
2. Add these secrets in the Replit **Secrets** panel:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_NUMBER`
   - `OPENAI_API_KEY`
3. Run:

   ```bash
   npm install
   npm start
   ```

4. Replit will expose a public URL such as `https://your-repl-name.your-account.repl.co`.

## Twilio webhook setup

In the Twilio Console for the phone number you want to use:

- **Messaging webhook**: set the incoming message webhook to:

  ```text
  https://YOUR-REPLIT-URL/webhook/sms
  ```

- **Voice webhook / missed-call callback**: point the webhook or status callback that fires for unanswered calls to:

  ```text
  https://YOUR-REPLIT-URL/webhook/voice
  ```

Use `POST` for both webhooks.

## Notes

- The app listens on `process.env.PORT || 3000` and binds to `0.0.0.0` for Replit compatibility.
- Conversation history is stored in memory with a `Map`, so restarting the app clears active sessions.
