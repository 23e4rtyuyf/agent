const POLL_INTERVAL_MS = 5000;

const elements = {
  totalCalls: document.getElementById('total-calls'),
  activeThreads: document.getElementById('active-threads'),
  urgentLeads: document.getElementById('urgent-leads'),
  completedLeads: document.getElementById('completed-leads'),
  leadList: document.getElementById('lead-list'),
  chatLog: document.getElementById('chat-log'),
  threadHeader: document.getElementById('thread-header'),
  leadInsights: document.getElementById('lead-insights'),
  searchInput: document.getElementById('search-input'),
  lastUpdated: document.getElementById('last-updated')
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

function escapeRouteParam(value) {
  return encodeURIComponent(value || '');
}

function getStatusBadgeClass(status) {
  if (status === 'URGENT') {
    return 'border-red-400/20 bg-red-500/10 text-red-100';
  }

  if (status === 'Completed') {
    return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';
  }

  return 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100';
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
}

function updateMetrics(leads) {
  const total = leads.length;
  const active = leads.filter((lead) => lead.conversationStatus === 'Active').length;
  const urgent = leads.filter((lead) => lead.conversationStatus === 'URGENT').length;
  const completed = leads.filter((lead) => lead.conversationStatus === 'Completed').length;

  elements.totalCalls.textContent = String(total);
  elements.activeThreads.textContent = String(active);
  elements.urgentLeads.textContent = String(urgent);
  elements.completedLeads.textContent = String(completed);
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

function renderLeadList() {
  const leads = getFilteredLeads();

  if (!leads.length) {
    elements.leadList.innerHTML = '<p class="p-5 text-sm text-slate-400">No leads match the current view.</p>';
    return;
  }

  const items = leads.map((lead) => {
    const selected = selectedPhoneNumber === lead.phoneNumber;
    const statusClass = getStatusBadgeClass(lead.conversationStatus);
    const leadName = lead.customerName && lead.customerName !== 'Unknown' ? lead.customerName : 'Unknown caller';
    const subtitle = lead.intent || 'Needs follow-up';

    return `
      <button
        class="w-full border-b border-white/5 px-5 py-4 text-left transition hover:bg-white/5 ${selected ? 'bg-white/10' : ''}"
        data-phone-number="${escapeHtml(lead.phoneNumber)}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-white">${escapeHtml(leadName)}</p>
            <p class="mt-1 truncate text-xs text-slate-400">${escapeHtml(lead.phoneNumber)}</p>
          </div>
          <span class="rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusClass}">${escapeHtml(lead.conversationStatus)}</span>
        </div>
        <p class="mt-3 text-sm text-slate-300">${escapeHtml(subtitle)}</p>
        <p class="mt-2 max-h-10 overflow-hidden text-xs text-slate-400">${escapeHtml(lead.leadSummary || lead.lastMessageSent || 'No updates yet.')}</p>
        <div class="mt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>${escapeHtml(lead.urgency || 'General Question')}</span>
          <span>${formatTimestamp(lead.timestamp)}</span>
        </div>
      </button>
    `;
  }).join('');

  elements.leadList.innerHTML = items;

  Array.from(elements.leadList.querySelectorAll('button[data-phone-number]')).forEach((button) => {
    button.addEventListener('click', () => {
      selectedPhoneNumber = button.dataset.phoneNumber;
      renderLeadList();
      void loadLeadDetails(selectedPhoneNumber);
    });
  });
}

function renderLeadInsights(lead) {
  const cards = [
    { label: 'Customer', value: lead.customerName || 'Unknown' },
    { label: 'Intent', value: lead.intent || 'Needs follow-up' },
    { label: 'Urgency', value: lead.urgency || 'General Question' },
    { label: 'Qualified', value: lead.conversationComplete ? 'Yes' : 'Not yet' }
  ].map((item) => `
    <div class="rounded-2xl border border-white/10 bg-slate-950/70 p-3">
      <p class="text-xs uppercase tracking-[0.2em] text-slate-500">${escapeHtml(item.label)}</p>
      <p class="mt-2 text-sm text-slate-200">${escapeHtml(item.value)}</p>
    </div>
  `).join('');

  const summary = `
    <div class="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
      <p class="text-xs uppercase tracking-[0.2em] text-slate-500">AI summary</p>
      <p class="mt-2 text-sm leading-6 text-slate-300">${escapeHtml(lead.leadSummary || 'No summary yet.')}</p>
    </div>
  `;

  elements.leadInsights.innerHTML = cards + summary;
}

function renderChatHistory(lead) {
  const leadName = lead.customerName && lead.customerName !== 'Unknown' ? lead.customerName : lead.phoneNumber;

  elements.threadHeader.innerHTML = `
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <p class="text-xs uppercase tracking-[0.24em] text-slate-500">Conversation detail</p>
        <h2 class="mt-2 text-2xl font-semibold text-white">${escapeHtml(leadName)}</h2>
        <p class="mt-1 text-sm text-slate-400">${escapeHtml(lead.phoneNumber)} • ${escapeHtml(lead.intent || 'Needs follow-up')}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <span class="rounded-full border px-3 py-1 text-xs font-semibold ${getStatusBadgeClass(lead.conversationStatus)}">${escapeHtml(lead.conversationStatus)}</span>
        <span class="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">Updated ${formatTimestamp(lead.timestamp)}</span>
      </div>
    </div>
  `;

  renderLeadInsights(lead);

  if (!Array.isArray(lead.history) || !lead.history.length) {
    elements.chatLog.innerHTML = '<p class="text-sm text-slate-400">No messages for this lead yet.</p>';
    return;
  }

  const bubbles = lead.history.map((message) => {
    const isUser = message.direction === 'user';
    const bubbleClass = isUser
      ? 'self-end rounded-[24px] rounded-br-md bg-cyan-500 px-4 py-3 text-slate-950'
      : 'self-start rounded-[24px] rounded-bl-md border border-white/10 bg-white/5 px-4 py-3 text-slate-100';
    const sender = isUser ? 'Customer' : message.direction === 'system' ? 'System' : 'AI assistant';
    const channel = message.channel && message.channel !== 'sms' ? ` • ${message.channel}` : '';

    return `
      <div class="max-w-[85%] ${bubbleClass}">
        <p class="text-[11px] font-semibold uppercase tracking-[0.2em] ${isUser ? 'text-slate-900/70' : 'text-slate-400'}">${escapeHtml(sender)}${escapeHtml(channel)}</p>
        <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6">${escapeHtml(message.content)}</p>
        <p class="mt-3 text-[11px] ${isUser ? 'text-slate-900/70' : 'text-slate-500'}">${formatTimestamp(message.timestamp)}</p>
      </div>
    `;
  }).join('');

  elements.chatLog.innerHTML = bubbles;
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

async function loadLeadDetails(phoneNumber) {
  if (!phoneNumber) {
    return;
  }

  try {
    const response = await fetch(`/api/leads/${escapeRouteParam(phoneNumber)}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch lead details: ${response.status}`);
    }

    const lead = await response.json();
    renderChatHistory(lead);
  } catch (error) {
    elements.chatLog.innerHTML = `<p class="text-sm text-red-300">Unable to load conversation: ${escapeHtml(error.message)}</p>`;
  }
}

async function refreshLeads() {
  try {
    const response = await fetch('/api/leads');

    if (!response.ok) {
      throw new Error(`Failed to fetch leads: ${response.status}`);
    }

    const leads = await response.json();
    latestLeads = Array.isArray(leads) ? leads : [];

    updateMetrics(latestLeads);
    renderLeadList();

    const visibleLeads = getFilteredLeads();

    if (!selectedPhoneNumber && visibleLeads.length) {
      selectedPhoneNumber = visibleLeads[0].phoneNumber;
      renderLeadList();
    }

    if (selectedPhoneNumber) {
      const stillExists = latestLeads.some((lead) => lead.phoneNumber === selectedPhoneNumber);
      if (stillExists) {
        await loadLeadDetails(selectedPhoneNumber);
      }
    }

    elements.lastUpdated.textContent = `Last updated ${formatTimestamp(new Date().toISOString())}`;
  } catch (error) {
    elements.leadList.innerHTML = `<p class="p-5 text-sm text-red-300">Unable to load leads: ${escapeHtml(error.message)}</p>`;
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
  } else {
    elements.threadHeader.innerHTML = `
      <h2 class="text-lg font-semibold text-white">Conversation detail</h2>
      <p class="mt-1 text-sm text-slate-400">Choose a lead to inspect the full timeline.</p>
    `;
    elements.chatLog.innerHTML = '<p class="text-sm text-slate-400">No lead selected.</p>';
    elements.leadInsights.innerHTML = '<p>Select a lead to see AI qualification details.</p>';
  }
});

void refreshLeads();
setInterval(() => {
  void refreshLeads();
}, POLL_INTERVAL_MS);
