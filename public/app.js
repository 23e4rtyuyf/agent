const POLL_INTERVAL_MS = 5000;

const elements = {
  totalCalls: document.getElementById('total-calls'),
  urgentLeads: document.getElementById('urgent-leads'),
  completedLeads: document.getElementById('completed-leads'),
  avgScore: document.getElementById('avg-score'),
  leadList: document.getElementById('lead-list'),
  chatLog: document.getElementById('chat-log'),
  threadHeader: document.getElementById('thread-header'),
  leadInsights: document.getElementById('lead-insights'),
  searchInput: document.getElementById('search-input'),
  lastUpdated: document.getElementById('last-updated'),
  stageBreakdown: document.getElementById('stage-breakdown'),
  urgencyBreakdown: document.getElementById('urgency-breakdown'),
  activityHeat: document.getElementById('activity-heat'),
  watchlist: document.getElementById('watchlist')
};

let selectedPhoneNumber = null;
let latestLeads = [];

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
}

function getBadgeClass(status) {
  if (status === 'URGENT') {
    return 'badge badge-urgent';
  }

  if (status === 'Completed') {
    return 'badge badge-complete';
  }

  return 'badge badge-active';
}

function getFilteredLeads() {
  const query = String(elements.searchInput.value || '').trim().toLowerCase();

  if (!query) {
    return latestLeads;
  }

  return latestLeads.filter((lead) => {
    return [lead.phoneNumber, lead.customerName, lead.intent, lead.leadSummary]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function renderStackRows(container, values = {}, fallbackLabel) {
  const entries = Object.entries(values);
  const total = entries.reduce((acc, [, count]) => acc + Number(count || 0), 0);

  if (!entries.length || total === 0) {
    container.innerHTML = `<p class="empty">${escapeHtml(fallbackLabel)}</p>`;
    return;
  }

  container.innerHTML = entries
    .map(([label, count]) => {
      const percent = Math.round((Number(count) / total) * 100);
      return `
        <div class="stack-row">
          <div class="meta">
            <span>${escapeHtml(label)}</span>
            <span>${count} (${percent}%)</span>
          </div>
          <div class="bar" style="width:${Math.max(percent, 3)}%"></div>
        </div>
      `;
    })
    .join('');
}

function renderActivityHeat(hourlyActivity = []) {
  if (!Array.isArray(hourlyActivity) || !hourlyActivity.length) {
    elements.activityHeat.innerHTML = '<p class="empty">No activity captured yet.</p>';
    return;
  }

  const maxValue = Math.max(...hourlyActivity.map((entry) => Number(entry.count || 0)), 1);

  elements.activityHeat.innerHTML = hourlyActivity
    .slice(-24)
    .map((entry) => {
      const count = Number(entry.count || 0);
      const intensity = Math.round((count / maxValue) * 100);
      const alpha = (0.16 + intensity / 130).toFixed(2);

      return `<div class="heat-cell" title="${escapeHtml(entry.hour)} • ${count} events" style="background: rgba(90, 209, 255, ${alpha});">${count}</div>`;
    })
    .join('');
}

function renderWatchlist(items = []) {
  if (!Array.isArray(items) || !items.length) {
    elements.watchlist.innerHTML = '<li>No at-risk threads right now.</li>';
    return;
  }

  elements.watchlist.innerHTML = items
    .map((item) => {
      return `<li><strong>${escapeHtml(item.phoneNumber)}</strong><br/>${escapeHtml(item.reason)}</li>`;
    })
    .join('');
}

function renderLeadList() {
  const leads = getFilteredLeads();

  if (!leads.length) {
    elements.leadList.innerHTML = '<p class="empty">No leads match this query.</p>';
    return;
  }

  elements.leadList.innerHTML = leads
    .map((lead) => {
      const score = Number(lead.opportunityScore || 0);
      const leadName = lead.customerName && lead.customerName !== 'Unknown' ? lead.customerName : 'Unknown caller';
      return `
        <button class="lead-item ${selectedPhoneNumber === lead.phoneNumber ? 'active' : ''}" data-phone="${escapeHtml(lead.phoneNumber)}">
          <div class="lead-head">
            <div>
              <div><strong>${escapeHtml(leadName)}</strong></div>
              <div class="meta-line">${escapeHtml(lead.phoneNumber)}</div>
            </div>
            <span class="${getBadgeClass(lead.conversationStatus)}">${escapeHtml(lead.conversationStatus)}</span>
          </div>
          <div class="meta-line">${escapeHtml(lead.intent || 'Needs follow-up')}</div>
          <div class="meta-line">Score ${score} • ${escapeHtml(lead.pipelineStage || 'New')} • ${escapeHtml(lead.urgency || 'General Question')}</div>
        </button>
      `;
    })
    .join('');

  Array.from(elements.leadList.querySelectorAll('[data-phone]')).forEach((button) => {
    button.addEventListener('click', () => {
      selectedPhoneNumber = button.dataset.phone;
      renderLeadList();
      void loadLeadDetails(selectedPhoneNumber);
    });
  });
}

function renderThreadHeader(lead) {
  const leadName = lead.customerName && lead.customerName !== 'Unknown' ? lead.customerName : lead.phoneNumber;
  elements.threadHeader.innerHTML = `
    <h2>${escapeHtml(leadName)}</h2>
    <p>${escapeHtml(lead.intent || 'Needs follow-up')} • ${escapeHtml(lead.conversationStatus)} • Updated ${formatTimestamp(lead.timestamp)}</p>
  `;
}

function renderChatHistory(lead) {
  if (!Array.isArray(lead.history) || !lead.history.length) {
    elements.chatLog.innerHTML = '<p class="empty">No messages available for this lead yet.</p>';
    return;
  }

  elements.chatLog.innerHTML = lead.history
    .map((message) => {
      const isUser = message.direction === 'user';
      const sender = isUser ? 'Customer' : message.direction === 'system' ? 'System' : 'AI Assistant';
      return `
        <article class="bubble ${isUser ? 'user' : ''}">
          <p class="bubble-head">${escapeHtml(sender)}${message.channel && message.channel !== 'sms' ? ` • ${escapeHtml(message.channel)}` : ''}</p>
          <p class="bubble-message">${escapeHtml(message.content)}</p>
          <p class="bubble-time">${formatTimestamp(message.timestamp)}</p>
        </article>
      `;
    })
    .join('');
}

function renderLeadInsights(lead) {
  const intelligence = lead.intelligence || {};

  const cards = [
    { label: 'Pipeline stage', value: lead.pipelineStage || 'New Inquiry' },
    { label: 'Opportunity score', value: String(lead.opportunityScore ?? 0) },
    { label: 'Close probability', value: `${lead.closeProbability ?? 0}%` },
    { label: 'Average response', value: `${intelligence.averageResponseSeconds ?? 0}s` },
    { label: 'Sentiment', value: intelligence.sentiment || 'Neutral' },
    { label: 'Next best action', value: intelligence.nextBestAction || 'Monitor thread' },
    { label: 'Risk level', value: intelligence.riskLevel || 'Low' },
    { label: 'Qualified', value: lead.conversationComplete ? 'Yes' : 'Not yet' },
    { label: 'Summary', value: lead.leadSummary || 'No summary yet.' }
  ];

  elements.leadInsights.innerHTML = cards
    .map((item) => {
      return `
        <article class="insight-card">
          <p class="label">${escapeHtml(item.label)}</p>
          <p class="value">${escapeHtml(item.value)}</p>
        </article>
      `;
    })
    .join('');
}

async function loadLeadDetails(phoneNumber) {
  if (!phoneNumber) {
    return;
  }

  try {
    const response = await fetch('/api/lead-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber })
    });

    if (!response.ok) {
      throw new Error(`Lead details failed with status ${response.status}`);
    }

    const lead = await response.json();
    renderThreadHeader(lead);
    renderChatHistory(lead);
    renderLeadInsights(lead);
  } catch (error) {
    elements.chatLog.innerHTML = `<p class="empty">Unable to load conversation: ${escapeHtml(error.message)}</p>`;
  }
}

function renderGlobalMetrics(leads, analytics) {
  const completed = leads.filter((lead) => lead.conversationStatus === 'Completed').length;
  const urgent = leads.filter((lead) => lead.conversationStatus === 'URGENT').length;
  const avgScore = analytics?.opportunity?.averageScore || 0;

  elements.totalCalls.textContent = String(leads.length);
  elements.completedLeads.textContent = String(completed);
  elements.urgentLeads.textContent = String(urgent);
  elements.avgScore.textContent = String(avgScore);
}

async function refreshDashboard() {
  try {
    const [leadsResponse, analyticsResponse] = await Promise.all([fetch('/api/leads'), fetch('/api/analytics')]);

    if (!leadsResponse.ok || !analyticsResponse.ok) {
      throw new Error(`Failed request (leads ${leadsResponse.status}, analytics ${analyticsResponse.status})`);
    }

    const [leads, analytics] = await Promise.all([leadsResponse.json(), analyticsResponse.json()]);

    latestLeads = Array.isArray(leads) ? leads : [];

    renderGlobalMetrics(latestLeads, analytics);
    renderStackRows(elements.stageBreakdown, analytics?.pipeline?.stageCounts, 'No stage data yet.');
    renderStackRows(elements.urgencyBreakdown, analytics?.pipeline?.urgencyCounts, 'No urgency data yet.');
    renderActivityHeat(analytics?.activity?.hourly || []);
    renderWatchlist(analytics?.watchlist || []);

    renderLeadList();

    const visibleLeads = getFilteredLeads();

    if (!selectedPhoneNumber && visibleLeads.length) {
      selectedPhoneNumber = visibleLeads[0].phoneNumber;
      renderLeadList();
    }

    if (selectedPhoneNumber) {
      const exists = latestLeads.some((lead) => lead.phoneNumber === selectedPhoneNumber);

      if (!exists) {
        selectedPhoneNumber = visibleLeads[0]?.phoneNumber || null;
      }

      if (selectedPhoneNumber) {
        await loadLeadDetails(selectedPhoneNumber);
      }
    }

    elements.lastUpdated.textContent = formatTimestamp(new Date().toISOString());
  } catch (error) {
    elements.leadList.innerHTML = `<p class="empty">Unable to refresh dashboard: ${escapeHtml(error.message)}</p>`;
  }
}

elements.searchInput.addEventListener('input', () => {
  const visibleLeads = getFilteredLeads();

  if (selectedPhoneNumber && !visibleLeads.some((lead) => lead.phoneNumber === selectedPhoneNumber)) {
    selectedPhoneNumber = visibleLeads[0]?.phoneNumber || null;
  }

  renderLeadList();

  if (selectedPhoneNumber) {
    void loadLeadDetails(selectedPhoneNumber);
  }
});

void refreshDashboard();
setInterval(() => {
  void refreshDashboard();
}, POLL_INTERVAL_MS);
