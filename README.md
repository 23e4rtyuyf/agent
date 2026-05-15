# Agent

A Replit-ready Node.js app for recovering missed calls, texting leads back automatically, and tracking every conversation in a polished dashboard.

## What this combines from the project branches

- missed-call voice + SMS webhook handling
- AI-generated lead qualification replies
- a live browser dashboard for monitoring conversations
- branch fixes for cleaner startup behavior and richer lead metadata in the UI

## Replit setup

1. Import this repository into Replit.
2. Add these secrets in the Replit **Secrets** panel:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_NUMBER`
   - `OPENAI_API_KEY`
3. Install and start the app:

   ```bash
   npm install
   npm start
   ```

4. Replit will expose a public URL. Use that URL for your Twilio webhooks.

## Twilio webhooks

Configure both endpoints with `POST`:

- Voice / missed call callback: `https://YOUR-REPLIT-URL/webhook/voice`
- SMS webhook: `https://YOUR-REPLIT-URL/webhook/sms`

## Dashboard

Open the Replit app URL in a browser to view the dashboard. It includes:

- lead volume, active threads, urgent leads, and qualified leads
- searchable lead inbox
- full conversation timeline
- AI-generated customer name, intent, urgency, and summary panels

## Notes

- The app listens on `0.0.0.0` and `process.env.PORT || 3000` for Replit compatibility.
- If `OPENAI_API_KEY` is missing, the app still responds with safe fallback messages.
- Lead data is stored in memory for the current process.
