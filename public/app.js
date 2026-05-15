const state = {
  leads: [],
  selectedPhone: null
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleString();
}

function leadBadge(lead) {
  if (lead.status === 'URGENT' || lead.urgency_level === 'URGENT') {
    return '<span class="ml-2 inline-flex animate-pulse rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">URGENT</span>';
  }
  return '<span class="ml-2 inline-flex rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">Routine</span>';
}

function renderSummary(summary = { total_missed_calls: 0, active_conversations: 0 }) {
  document.getElementById('totalMissed').textContent = String(summary.total_missed_calls || 0);
  document.getElementById('activeConversations').textContent = String(summary.active_conversations || 0);
}

function renderLeadList() {
  const leadList = document.getElementById('leadList');
  leadList.innerHTML = '';

  if (!state.leads.length) {
    leadList.innerHTML = '<li class="p-4 text-sm text-slate-400">No leads yet.</li>';
    return;
  }

  state.leads.forEach((lead) => {
    const li = document.createElement('li');
    const selected = lead.phone === state.selectedPhone;
    const urgent = lead.status === 'URGENT' || lead.urgency_level === 'URGENT';
    li.className = `cursor-pointer border-b border-slate-800 p-4 transition ${selected ? 'bg-slate-800' : 'hover:bg-slate-800/70'} ${urgent ? 'ring-1 ring-red-500/80' : ''}`;
    li.innerHTML = `
      <div class="flex items-center justify-between">
        <p class="font-medium">${escapeHtml(lead.client_name || 'Unknown Lead')}</p>
        ${leadBadge(lead)}
      </div>
      <p class="mt-1 text-sm text-slate-300">${escapeHtml(lead.phone)}</p>
      <p class="mt-1 text-xs text-slate-400">Intent: ${escapeHtml(lead.intent || 'Inquiry')} · Missed: ${lead.missed_calls || 0}</p>
    `;
    li.onclick = () => {
      state.selectedPhone = lead.phone;
      renderLeadList();
      renderConversation();
    };
    leadList.appendChild(li);
  });
}

function renderConversation() {
  const conversation = document.getElementById('conversation');
  const header = document.getElementById('conversationHeader');

  let selected = state.leads.find((lead) => lead.phone === state.selectedPhone) || null;
  if (!selected && state.leads[0]) {
    state.selectedPhone = state.leads[0].phone;
    selected = state.leads[0];
  }

  if (!selected) {
    header.textContent = 'Select a lead to view conversation history.';
    conversation.innerHTML = '<p class="text-sm text-slate-400">No conversation data available.</p>';
    return;
  }

  state.selectedPhone = selected.phone;
  const urgency = selected.status === 'URGENT' || selected.urgency_level === 'URGENT';
  header.innerHTML = `
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="font-semibold text-slate-100">${escapeHtml(selected.client_name || 'Unknown Lead')} (${escapeHtml(selected.phone)})</p>
        <p class="text-xs text-slate-400">Intent: ${escapeHtml(selected.intent || 'Inquiry')}</p>
      </div>
      ${leadBadge(selected)}
    </div>
  `;

  if (!selected.messages?.length) {
    conversation.innerHTML = '<p class="text-sm text-slate-400">No messages yet.</p>';
    return;
  }

  conversation.innerHTML = selected.messages
    .map((msg) => {
      const isUser = msg.role === 'user';
      const bubbleClass = isUser
        ? 'ml-auto bg-cyan-500 text-white'
        : msg.role === 'assistant'
          ? 'mr-auto bg-slate-700 text-slate-100'
          : 'mx-auto bg-slate-800 text-slate-300';
      return `
        <div class="max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow ${bubbleClass}">
          <p>${escapeHtml(msg.text || '')}</p>
          <p class="mt-1 text-[10px] opacity-75">${formatTime(msg.at)}</p>
        </div>
      `;
    })
    .join('');

  if (urgency) {
    document.body.classList.add('ring-2', 'ring-red-500');
  } else {
    document.body.classList.remove('ring-2', 'ring-red-500');
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/leads');
    const data = await response.json();
    state.leads = Array.isArray(data.leads) ? data.leads : [];
    renderSummary(data.summary || {});
    if (!state.selectedPhone && state.leads[0]) {
      state.selectedPhone = state.leads[0].phone;
    }
    renderLeadList();
    renderConversation();
  } catch (error) {
    console.error('Failed to load leads', error);
  }
}

refresh();
setInterval(refresh, 5000);
