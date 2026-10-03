require('dotenv').config();

const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { generateReply, getAIUsageMetrics } = require('./ai');

const app = express();
const handledMissedCalls = new Map();
const leadsByPhone = new Map();
const leadStateHistory = new Map();

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

function getPipelineStage(lead) {
  const hasUserMessages = lead.history.some((entry) => entry.direction === 'user');
  const hasAssistantMessages = lead.history.some((entry) => entry.direction === 'assistant');

  if (lead.conversationStatus === 'Completed' || lead.conversationComplete) {
    return 'Qualified';
  }

  if (lead.conversationStatus === 'URGENT') {
    return 'Priority Dispatch';
  }

  if (hasUserMessages && hasAssistantMessages) {
    return 'Engaged';
  }

  if (hasUserMessages) {
    return 'Awaiting Response';
  }

  return 'New Inquiry';
}

function getAverageResponseSeconds(lead) {
  const history = Array.isArray(lead.history) ? lead.history : [];
  let pendingUserTimestamp = null;
  const responseSeconds = [];

  for (const event of history) {
    const eventTimestamp = Date.parse(event.timestamp);

    if (Number.isNaN(eventTimestamp)) {
      continue;
    }

    if (event.direction === 'user') {
      pendingUserTimestamp = eventTimestamp;
      continue;
    }

    if (pendingUserTimestamp !== null && event.direction === 'assistant') {
      const delta = Math.round((eventTimestamp - pendingUserTimestamp) / 1000);
      if (delta >= 0) {
        responseSeconds.push(delta);
      }
      pendingUserTimestamp = null;
    }
  }

  if (!responseSeconds.length) {
    return 0;
  }

  const total = responseSeconds.reduce((acc, value) => acc + value, 0);
  return Math.round(total / responseSeconds.length);
}

function detectSentiment(lead) {
  const latestUserMessage = [...lead.history].reverse().find((entry) => entry.direction === 'user');

  if (!latestUserMessage) {
    return 'Neutral';
  }

  const text = String(latestUserMessage.content || '').toLowerCase();

  if (/thank|great|awesome|perfect|amazing|good/.test(text)) {
    return 'Positive';
  }

  if (/frustrated|angry|upset|disappointed|terrible|bad/.test(text)) {
    return 'Negative';
  }

  return 'Neutral';
}

function getOpportunityScore(lead) {
  let score = 20;

  if (lead.conversationComplete) {
    score += 30;
  }

  if (lead.conversationStatus === 'URGENT') {
    score += 25;
  }

  if (lead.urgency === 'Routine Booking') {
    score += 10;
  }

  if (lead.customerName && lead.customerName !== 'Unknown') {
    score += 8;
  }

  if (lead.intent && !/follow-up/i.test(lead.intent)) {
    score += 8;
  }

  const historyDepth = Math.min((lead.history?.length || 0) * 2, 20);
  score += historyDepth;

  return Math.min(100, Math.max(0, score));
}

function getCloseProbability(lead, opportunityScore) {
  const responseSeconds = getAverageResponseSeconds(lead);
  let probability = opportunityScore;

  if (responseSeconds > 0 && responseSeconds < 120) {
    probability += 10;
  } else if (responseSeconds > 900) {
    probability -= 12;
  }

  if (lead.conversationStatus === 'URGENT') {
    probability += 5;
  }

  if (lead.emergency) {
    probability -= 8;
  }

  return Math.min(100, Math.max(5, Math.round(probability)));
}

function getRiskLevel(lead, opportunityScore) {
  if (lead.conversationStatus === 'URGENT' && !lead.conversationComplete) {
    return 'High';
  }

  const lastUpdate = Date.parse(lead.timestamp);
  if (!Number.isNaN(lastUpdate) && Date.now() - lastUpdate > 45 * 60 * 1000 && !lead.conversationComplete) {
    return 'Medium';
  }

  if (opportunityScore < 35) {
    return 'Medium';
  }

  return 'Low';
}

function getNextBestAction(lead, intelligence) {
  if (lead.conversationStatus === 'URGENT') {
    return 'Immediate human callback with dispatch priority.';
  }

  if (lead.conversationComplete) {
    return 'Hand-off to scheduling/sales for confirmation.';
  }

  if (intelligence.sentiment === 'Negative') {
    return 'Escalate to human to recover trust and clarify expectations.';
  }

  if (intelligence.averageResponseSeconds > 600) {
    return 'Send a follow-up with clearer options and urgency prompt.';
  }

  return 'Collect remaining qualification details (timeframe and budget).';
}

function buildLeadIntelligence(lead) {
  const averageResponseSeconds = getAverageResponseSeconds(lead);
  const sentiment = detectSentiment(lead);
  const opportunityScore = getOpportunityScore(lead);
  const riskLevel = getRiskLevel(lead, opportunityScore);

  const intelligence = {
    averageResponseSeconds,
    sentiment,
    riskLevel,
    nextBestAction: ''
  };

  intelligence.nextBestAction = getNextBestAction(lead, intelligence);

  return {
    pipelineStage: getPipelineStage(lead),
    opportunityScore,
    closeProbability: getCloseProbability(lead, opportunityScore),
    intelligence
  };
}

function updateLead(phoneNumber, updates = {}) {
  const lead = getLead(phoneNumber);
  const previousStatus = lead.conversationStatus;

  lead.timestamp = new Date().toISOString();
  Object.assign(lead, updates);

  if (!leadStateHistory.has(lead.phoneNumber)) {
    leadStateHistory.set(lead.phoneNumber, []);
  }

  if (previousStatus !== lead.conversationStatus) {
    leadStateHistory.get(lead.phoneNumber).push({
      from: previousStatus,
      to: lead.conversationStatus,
      timestamp: lead.timestamp
    });
  }

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
  const insight = buildLeadIntelligence(lead);

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
    historyCount: Array.isArray(lead.history) ? lead.history.length : 0,
    pipelineStage: insight.pipelineStage,
    opportunityScore: insight.opportunityScore,
    closeProbability: insight.closeProbability,
    intelligence: insight.intelligence
  };
}

function sortedLeadSummaries() {
  return Array.from(leadsByPhone.values())
    .map((lead) => summarizeLead(lead))
    .sort((a, b) => {
      if (a.conversationStatus === 'URGENT' && b.conversationStatus !== 'URGENT') {
        return -1;
      }

      if (b.conversationStatus === 'URGENT' && a.conversationStatus !== 'URGENT') {
        return 1;
      }

      return Date.parse(b.timestamp) - Date.parse(a.timestamp);
    });
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

function buildHourlyActivity(leads) {
  const bucketByHour = new Map();

  for (let i = 23; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 60 * 60 * 1000);
    const label = `${String(date.getHours()).padStart(2, '0')}:00`;
    bucketByHour.set(label, 0);
  }

  for (const lead of leads) {
    for (const event of lead.history || []) {
      const eventDate = new Date(event.timestamp);
      if (Number.isNaN(eventDate.getTime())) {
        continue;
      }

      const eventAge = Date.now() - eventDate.getTime();
      if (eventAge < 0 || eventAge > 24 * 60 * 60 * 1000) {
        continue;
      }

      const label = `${String(eventDate.getHours()).padStart(2, '0')}:00`;
      bucketByHour.set(label, (bucketByHour.get(label) || 0) + 1);
    }
  }

  return Array.from(bucketByHour.entries()).map(([hour, count]) => ({ hour, count }));
}

function buildAnalyticsSnapshot() {
  const summaries = sortedLeadSummaries();

  const stageCounts = {};
  const urgencyCounts = {};
  const riskCounts = { Low: 0, Medium: 0, High: 0 };

  let totalScore = 0;

  for (const summary of summaries) {
    stageCounts[summary.pipelineStage] = (stageCounts[summary.pipelineStage] || 0) + 1;
    urgencyCounts[summary.urgency] = (urgencyCounts[summary.urgency] || 0) + 1;
    riskCounts[summary.intelligence.riskLevel] = (riskCounts[summary.intelligence.riskLevel] || 0) + 1;
    totalScore += summary.opportunityScore;
  }

  const averageScore = summaries.length ? Math.round(totalScore / summaries.length) : 0;
  const qualifiedLeads = summaries.filter((lead) => lead.conversationStatus === 'Completed').length;
  const urgentLeads = summaries.filter((lead) => lead.conversationStatus === 'URGENT').length;
  const activeLeads = summaries.filter((lead) => lead.conversationStatus === 'Active').length;
  const totalTransitionEvents = Array.from(leadStateHistory.values()).reduce((acc, transitions) => {
    return acc + (Array.isArray(transitions) ? transitions.length : 0);
  }, 0);

  const watchlist = summaries
    .filter((summary) => {
      return summary.intelligence.riskLevel !== 'Low' && summary.conversationStatus !== 'Completed';
    })
    .slice(0, 8)
    .map((summary) => {
      const staleMinutes = Math.max(0, Math.round((Date.now() - Date.parse(summary.timestamp)) / 60000));
      return {
        phoneNumber: summary.phoneNumber,
        reason: `${summary.intelligence.riskLevel} risk • ${summary.pipelineStage} • stale ${staleMinutes}m`
      };
    });

  return {
    totals: {
      leads: summaries.length,
      urgent: urgentLeads,
      qualified: qualifiedLeads,
      active: activeLeads
    },
    opportunity: {
      averageScore
    },
    conversion: {
      qualifiedRate: summaries.length ? Math.round((qualifiedLeads / summaries.length) * 100) : 0,
      urgentRate: summaries.length ? Math.round((urgentLeads / summaries.length) * 100) : 0,
      transitionEvents: totalTransitionEvents
    },
    pipeline: {
      stageCounts,
      urgencyCounts,
      riskCounts
    },
    ai: getAIUsageMetrics(),
    watchlist,
    activity: {
      hourly: buildHourlyActivity(Array.from(leadsByPhone.values()))
    }
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

app.get('/api/analytics', (_req, res) => {
  return res.json(buildAnalyticsSnapshot());
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

  const summary = summarizeLead(lead);

  return res.json({
    ...summary,
    history: lead.history,
    transitions: leadStateHistory.get(requestedPhoneNumber) || []
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
