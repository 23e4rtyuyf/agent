const POLL_INTERVAL_MS = 5000;

const elements = {
  totalCalls: document.getElementById('total-calls'),
  activeThreads: document.getElementById('active-threads'),
  urgentLeads: document.getElementById('urgent-leads'),
  leadList: document.getElementById('lead-list'),
  chatLog: document.getElementById('chat-log'),
  threadHeader: document.getElementById('thread-header')
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
    return 'bg-red-100 text-red-700 border-red-200';
  }

  if (status === 'Completed') {
    return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  }

  return 'bg-blue-100 text-blue-700 border-blue-200';
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

  elements.totalCalls.textContent = String(total);
  elements.activeThreads.textContent = String(active);
  elements.urgentLeads.textContent = String(urgent);
}

function renderLeadList(leads) {
  if (!leads.length) {
    elements.leadList.innerHTML = '<p class="p-4 text-sm text-slate-500">No leads yet.</p>';
    return;
  }

  const items = leads.map((lead) => {
    const selected = selectedPhoneNumber === lead.phoneNumber;
    const statusClass = getStatusBadgeClass(lead.conversationStatus);

    return `
      <button
        class="w-full text-left px-4 py-3 border-b border-slate-200 hover:bg-slate-100 ${selected ? 'bg-slate-100' : ''}"
        data-phone-number="${escapeHtml(lead.phoneNumber)}"
      >
        <div class="flex items-center justify-between gap-2 mb-1">
          <p class="font-medium text-slate-800 truncate">${escapeHtml(lead.phoneNumber)}</p>
          <span class="text-xs px-2 py-0.5 rounded-full border ${statusClass}">${escapeHtml(lead.conversationStatus)}</span>
        </div>
        <p class="text-xs text-slate-500 truncate">${escapeHtml(lead.lastMessageSent || 'No outbound message yet')}</p>
        <p class="text-[11px] text-slate-400 mt-1">${formatTimestamp(lead.timestamp)}</p>
      </button>
    `;
  }).join('');

  elements.leadList.innerHTML = items;

  Array.from(elements.leadList.querySelectorAll('button[data-phone-number]')).forEach((button) => {
    button.addEventListener('click', () => {
      selectedPhoneNumber = button.dataset.phoneNumber;
      renderLeadList(latestLeads);
      void loadLeadDetails(selectedPhoneNumber);
    });
  });
}

function renderChatHistory(lead) {
  elements.threadHeader.innerHTML = `
    <h2 class="font-semibold">${escapeHtml(lead.phoneNumber)}</h2>
    <p class="text-sm text-slate-500">Status: ${escapeHtml(lead.conversationStatus)} • Updated: ${formatTimestamp(lead.timestamp)}</p>
  `;

  if (!Array.isArray(lead.history) || !lead.history.length) {
    elements.chatLog.innerHTML = '<p class="text-sm text-slate-500">No messages for this lead yet.</p>';
    return;
  }

  const bubbles = lead.history.map((message) => {
    const isUser = message.direction === 'user';
    const alignClass = isUser ? 'justify-end' : 'justify-start';
    const bubbleClass = isUser
      ? 'bg-slate-800 text-white rounded-br-sm'
      : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm';
    const sender = isUser ? 'User' : 'AI';

    return `
      <div class="flex ${alignClass}">
        <div class="max-w-[80%] px-3 py-2 rounded-2xl shadow-sm ${bubbleClass}">
          <p class="text-xs opacity-70 mb-1">${sender} • ${formatTimestamp(message.timestamp)}</p>
          <p class="text-sm whitespace-pre-wrap break-words">${escapeHtml(message.content)}</p>
        </div>
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
    elements.chatLog.innerHTML = `<p class="text-sm text-red-600">Unable to load conversation: ${escapeHtml(error.message)}</p>`;
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
    renderLeadList(latestLeads);

    if (!selectedPhoneNumber && latestLeads.length) {
      selectedPhoneNumber = latestLeads[0].phoneNumber;
      renderLeadList(latestLeads);
    }

    if (selectedPhoneNumber) {
      const stillExists = latestLeads.some((lead) => lead.phoneNumber === selectedPhoneNumber);
      if (stillExists) {
        await loadLeadDetails(selectedPhoneNumber);
      }
    }
  } catch (error) {
    elements.leadList.innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load leads: ${escapeHtml(error.message)}</p>`;
  }
}

void refreshLeads();
setInterval(() => {
  void refreshLeads();
}, POLL_INTERVAL_MS);
