import { supabase } from './supabase.js';
import { state } from './state.js';
import { esc, toast, errorMessage } from './ui.js';
import { openTaskPanel } from './pages/task-panel.js';
import { timeAgo } from './pages/task-discussion.js';
import { showDashboardMonth } from './pages/dashboards.js';

// The bell in the top bar: unread count, newest first, click to open
let items = [];
let slot = null;
let open = false;
let seen = new Set();

const ICON = {
  assigned: '👤', mentioned: '@', commented: '💬', due_tomorrow: '⏰', overdue: '⚠️', hours_reminder: '🕒', budget_alert: '📊',
};

const BELL = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 11V8a5 5 0 0 0-5-5zM8 15.5a2 2 0 0 0 4 0"
  fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

export function mountBell(container) {
  slot = container;
  items = [];
  seen = new Set();
  open = false;
  slot.innerHTML = `
    <div class="bell">
      <button class="bell-button" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
        ${BELL}<span class="bell-badge" hidden></span>
      </button>
      <div class="bell-panel" hidden>
        <div class="bell-head">
          <strong>Notifications</strong>
          <button class="btn btn-small btn-ghost" type="button" data-read-all>Mark all as read</button>
        </div>
        <ul class="bell-list" data-list></ul>
      </div>
    </div>`;
  const button = slot.querySelector('.bell-button');
  const panel = slot.querySelector('.bell-panel');
  const setOpen = value => {
    open = value;
    panel.hidden = !value;
    button.setAttribute('aria-expanded', String(value));
  };
  button.addEventListener('click', event => { event.stopPropagation(); setOpen(!open); });
  document.addEventListener('click', event => { if (open && !panel.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && open) setOpen(false); });
  slot.querySelector('[data-read-all]').addEventListener('click', markAllRead);
  slot.querySelector('[data-list]').addEventListener('click', event => {
    const row = event.target.closest('[data-id]');
    if (row) {
      setOpen(false);
      openNotification(items.find(n => n.id === row.dataset.id));
    }
  });
  load({ first: true });
}

window.addEventListener('notifications-changed', () => { if (slot && state.me) load(); });

async function load({ first = false } = {}) {
  const { data, error } = await supabase
    .from('notifications').select('*').eq('recipient_id', state.me.id)
    .order('created_at', { ascending: false }).limit(50);
  if (error || !slot) return;
  // A short pop-up for anything new that arrived while the page was open
  if (!first) {
    data.filter(n => !seen.has(n.id) && !n.read_at).slice(0, 3).forEach(n => toast(n.message, 'info'));
  }
  data.forEach(n => seen.add(n.id));
  items = data;
  draw();
}

function draw() {
  const unread = items.filter(n => !n.read_at).length;
  const badge = slot.querySelector('.bell-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  slot.querySelector('.bell-button').setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  slot.querySelector('[data-read-all]').disabled = !unread;

  const list = slot.querySelector('[data-list]');
  list.innerHTML = items.length ? items.map(n => `
    <li>
      <button type="button" class="bell-item ${n.read_at ? '' : 'is-unread'}" data-id="${esc(n.id)}">
        <span class="bell-icon" aria-hidden="true">${ICON[n.type] || '•'}</span>
        <span class="bell-text">
          <span>${esc(n.message)}</span>
          <span class="muted small">${esc(timeAgo(n.created_at))}</span>
        </span>
        ${n.read_at ? '' : '<span class="unread-dot" aria-label="Unread"></span>'}
      </button>
    </li>`).join('') : '<li class="bell-empty muted">Nothing yet. You\'ll be told here when you\'re assigned, mentioned, or something is due.</li>';
}

async function markRead(ids) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  items.forEach(n => { if (ids.includes(n.id)) n.read_at = now; });
  draw();
  const { error } = await supabase.from('notifications').update({ read_at: now }).in('id', ids);
  if (error) toast(errorMessage(error), 'error');
}

function markAllRead() {
  markRead(items.filter(n => !n.read_at).map(n => n.id));
}

// Budget alerts open Dashboards; everything else opens its task
function openNotification(n) {
  if (!n) return;
  if (!n.read_at) markRead([n.id]);
  if (n.type === 'budget_alert') {
    if (n.month) showDashboardMonth(n.month.slice(0, 7));
    // Already on Dashboards: redraw it for the alert's month
    if (window.location.hash === '#/dashboards') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else window.location.hash = '/dashboards';
  } else if (n.type === 'hours_reminder') {
    window.location.hash = '/my-time';
  } else if (n.task_id) {
    openTaskPanel(n.task_id);
  }
}

export function clearBell() {
  slot = null;
  items = [];
}
