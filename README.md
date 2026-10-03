# Signal Forge Agent

Signal Forge is an AI-native missed-call recovery platform with a handcrafted intelligence console.

## What it does

- captures missed calls and sends automatic text-back responses
- runs AI-driven SMS qualification for name, intent, urgency, and summary
- scores every lead with opportunity and close-probability heuristics
- computes real-time operational analytics (pipeline stages, risk watchlist, hourly activity)
- exposes AI efficiency telemetry (model vs rule-based share, fallback rate, response-size proxy)
- provides a custom dashboard UI for conversation operations and decision support

## Replit setup

1. Import this repository into Replit.
2. Add these secrets in Replit **Secrets**:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_NUMBER`
   - `OPENAI_API_KEY`
   - optional cost controls:
     - `AI_CREDITS_MODE=low` (more rule-based replies during cooldown windows)
     - `OPENAI_MAX_TOKENS=220` (cap response tokens)
     - `OPENAI_MODEL_COOLDOWN_MS=45000` (minimum gap between model calls per lead)
3. Install and start:

   ```bash
   npm install
   npm start
   ```

## Webhooks

Configure Twilio with `POST`:

- Voice callback: `https://YOUR-REPLIT-URL/webhook/voice`
- SMS callback: `https://YOUR-REPLIT-URL/webhook/sms`

## API endpoints

- `GET /health`
- `GET /api/leads`
- `GET /api/analytics`
- `POST /api/lead-details`

## Notes

- App listens on `0.0.0.0` and `process.env.PORT || 3000`.
- If `OPENAI_API_KEY` is missing, fallback responses still keep conversations active.
- Data is in-memory for the running process.
