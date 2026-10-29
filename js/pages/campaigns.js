import { supabase } from '../supabase.js';
import { state, canEditWork, personById } from '../state.js';
import { onTasksChanged, onLiveChange } from '../realtime.js';
import { tasksDonePct, todayIso } from '../tasks.js';
import { loadCampaignHours } from '../time.js';
import {
  esc, options, statusPill, avatar, fmtHours, toast, errorMessage, formDialog,
  BUSINESS_UNITS, CAMPAIGN_STATUSES,
} from '../ui.js';

// Kept between visits so the list looks the same when coming back to it
const filters = { search: '', bu: '', owner: '', view: 'active', mine: false, sort: 'start', dir: 'desc' };

const VIEWS = {
  active: { label: 'Active', statuses: ['planned', 'in_progress'] },
  closed: { label: 'Done & on hold', statuses: ['done', 'on_hold'] },
  all: { label: 'All', statuses: null },
};

// Main tasks (not subtasks) of every campaign, for the "% of tasks done" column
async function loadTaskProgress() {
  const { data, error } = await supabase.from('tasks').select('campaign_id, parent_id, status').is('parent_id', null);
  if (error) throw error;
  const byCampaign = {};
  data.forEach(t => { (byCampaign[t.campaign_id] ||= []).push(t); });
  return Object.fromEntries(Object.entries(byCampaign).map(([id, tasks]) => [id, tasksDonePct(tasks)]));
}

export async function renderCampaigns(el) {
  const owners = state.people.filter(p => p.active && p.role !== 'director');
  el.innerHTML = `
    <div class="page-header">
      <h1>Campaigns</h1>
      ${canEditWork() ? '<button class="btn btn-primary" type="button" data-new>New campaign</button>' : ''}
    </div>
    <div class="campaign-tabs">
      <nav class="tabs" aria-label="Which campaigns" data-views></nav>
      <label class="toggle"><input type="checkbox" data-mine ${filters.mine ? 'checked' : ''}> Only mine</label>
    </div>
    <div class="filters">
      <input class="search" type="search" placeholder="Search campaigns" aria-label="Search campaigns" value="${esc(filters.search)}">
      <select data-filter="bu" aria-label="Business unit">
        <option value="">All business units</option>${options(BUSINESS_UNITS, filters.bu)}
      </select>
      <select data-filter="owner" aria-label="Owner">
        <option value="">All owners</option>${options(Object.fromEntries(owners.map(p => [p.id, p.name])), filters.owner)}
      </select>
      <button class="btn btn-ghost" type="button" data-clear>Clear</button>
    </div>
    <div data-list><p class="muted">Loading campaigns…</p></div>`;

  const list = el.querySelector('[data-list]');
  el.querySelector('[data-new]')?.addEventListener('click', () =>
    openCampaignForm(null, saved => { window.location.hash = `/campaigns/${saved.id}`; }));

  const [campaignResult, progressResult, hoursResult] = await Promise.allSettled([
    supabase.from('campaigns').select('*').order('name'),
    loadTaskProgress(),
    loadCampaignHours(),
  ]);
  const error = campaignResult.reason || campaignResult.value?.error || progressResult.reason || hoursResult.reason;
  if (error) {
    list.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const data = { campaigns: campaignResult.value.data, progress: progressResult.value, hours: hoursResult.value };

  const draw = () => {
    drawViews(el, data, draw);
    drawList(list, data, draw);
  };
  onTasksChanged(el, async () => {
    try {
      data.progress = await loadTaskProgress();
      draw();
    } catch { /* keep what's shown */ }
  });
  onLiveChange(el, 'time-changed', async () => {
    try {
      data.hours = await loadCampaignHours();
      draw();
    } catch { /* keep what's shown */ }
  });
  el.querySelector('.search').addEventListener('input', event => { filters.search = event.target.value; draw(); });
  el.querySelectorAll('[data-filter]').forEach(select =>
    select.addEventListener('change', () => { filters[select.dataset.filter] = select.value; draw(); }));
  el.querySelector('[data-mine]').addEventListener('change', event => { filters.mine = event.target.checked; draw(); });
  el.querySelector('[data-clear]').addEventListener('click', () => {
    Object.assign(filters, { search: '', bu: '', owner: '', mine: false });
    el.querySelector('.search').value = '';
    el.querySelector('[data-mine]').checked = false;
    el.querySelectorAll('[data-filter]').forEach(select => { select.value = ''; });
    draw();
  });
  draw();
}

// Everything except the Active / Done / All tab
function matchesFilters(campaign) {
  const q = filters.search.trim().toLowerCase();
  return (!filters.bu || campaign.business_unit === filters.bu)
    && (!filters.owner || campaign.owner_id === filters.owner)
    && (!filters.mine || campaign.owner_id === state.me.id)
    && (!q || `${campaign.name} ${campaign.description || ''}`.toLowerCase().includes(q));
}

const inView = (campaign, view) => !VIEWS[view].statuses || VIEWS[view].statuses.includes(campaign.status);

function drawViews(el, data, draw) {
  const filtered = data.campaigns.filter(matchesFilters);
  const nav = el.querySelector('[data-views]');
  nav.innerHTML = Object.entries(VIEWS).map(([key, v]) => `
    <button type="button" class="tab ${filters.view === key ? 'active' : ''}" data-view="${key}" aria-pressed="${filters.view === key}">
      ${esc(v.label)} <span class="tab-count">${filtered.filter(c => inView(c, key)).length}</span>
    </button>`).join('');
  nav.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    filters.view = button.dataset.view;
    draw();
  }));
}

// "1 Oct – 31 Dec", with the year only when it isn't this year
function compactRange(start, end) {
  const parse = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const thisYear = new Date().getFullYear();
  const fmt = (iso, withYear) => parse(iso).toLocaleDateString('en-GB',
    withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  if (!start && !end) return '—';
  if (!end) return `From ${fmt(start, parse(start).getFullYear() !== thisYear)}`;
  if (!start) return `Until ${fmt(end, parse(end).getFullYear() !== thisYear)}`;
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const showYear = !sameYear || Number(end.slice(0, 4)) !== thisYear;
  return `${fmt(start, !sameYear)} – ${fmt(end, showYear)}`;
}

// Past its end date but not marked Done or On hold
function endedFlag(c) {
  if (!c.end_date || c.status === 'done' || c.status === 'on_hold') return '';
  const today = todayIso();
  if (c.end_date >= today) return '';
  const days = Math.round((new Date(today) - new Date(c.end_date)) / 86400000);
  return `<span class="ended-flag" title="Past its end date but not marked Done">Ended ${days} day${days === 1 ? '' : 's'} ago</span>`;
}

function bar(pct, level) {
  return `<span class="mini-meter meter-${level}" aria-hidden="true"><span style="width:${Math.min(100, pct)}%"></span></span>`;
}

const SORTS = {
  name: c => c.name.toLowerCase(),
  owner: c => personById(c.owner_id)?.name.toLowerCase() || '~',
  start: c => c.start_date || '',
  status: c => Object.keys(CAMPAIGN_STATUSES).indexOf(c.status),
  hours: c => c.hoursPct ?? c.logged / 1000,
  tasks: c => c.tasksPct ?? -1,
};

function drawList(list, data, draw) {
  if (!data.campaigns.length) {
    list.innerHTML = `<div class="empty-state"><p>No campaigns yet.${canEditWork() ? ' Create the first one with “New campaign”.' : ''}</p></div>`;
    return;
  }
  const shown = data.campaigns
    .filter(c => matchesFilters(c) && inView(c, filters.view))
    .map(c => {
      const logged = Number(data.hours[c.id]?.hours || 0);
      const planned = Number(c.planned_hours);
      return { ...c, logged, planned, hoursPct: planned > 0 ? logged / planned * 100 : null, tasksPct: data.progress[c.id] ?? null };
    });
  if (!shown.length) {
    list.innerHTML = `<div class="empty-state"><p>No ${filters.view === 'all' ? '' : `${VIEWS[filters.view].label.toLowerCase()} `}campaigns match.
      ${filters.view !== 'all' ? 'Try the <strong>All</strong> tab or clear the filters.' : 'Try clearing the filters.'}</p></div>`;
    return;
  }

  const key = SORTS[filters.sort];
  shown.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const order = x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name);
    return filters.dir === 'asc' ? order : -order;
  });

  const header = (sortKey, label, cls = '') => {
    const active = filters.sort === sortKey;
    const arrow = active ? (filters.dir === 'asc' ? '↑' : '↓') : '';
    return `<th class="${cls}" aria-sort="${active ? (filters.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="sort-btn" data-sort="${sortKey}">${label} <span aria-hidden="true">${arrow}</span></button></th>`;
  };

  list.innerHTML = `
    <div class="table-wrap">
      <table class="table campaign-table">
        <thead>
          <tr>
            ${header('name', 'Campaign')}${header('owner', 'Owner')}${header('start', 'Dates')}${header('status', 'Status')}
            ${header('hours', 'Hours logged / planned', 'meter-head')}${header('tasks', 'Tasks done', 'meter-head')}
          </tr>
        </thead>
        <tbody>
          ${shown.map(c => {
            const owner = personById(c.owner_id);
            const hoursLevel = c.hoursPct == null ? 'none' : c.hoursPct > 100 ? 'critical' : c.hoursPct >= 80 ? 'warning' : 'good';
            return `
              <tr class="clickable" data-href="#/campaigns/${esc(c.id)}">
                <td data-label="Campaign">
                  <a class="row-link campaign-link" href="#/campaigns/${esc(c.id)}">${esc(c.name)}</a>
                  <span class="unit-line"><span class="unit-dot unit-dot-${esc(c.business_unit)}" aria-hidden="true"></span>${esc(BUSINESS_UNITS[c.business_unit])}</span>
                  ${endedFlag(c)}
                </td>
                <td data-label="Owner">${owner ? `<span class="person">${avatar(owner, 24)}${esc(owner.name)}</span>` : '<span class="muted">—</span>'}</td>
                <td data-label="Dates" class="nowrap">${esc(compactRange(c.start_date, c.end_date))}</td>
                <td data-label="Status">${statusPill(c.status)}</td>
                <td data-label="Hours" class="meter-cell">
                  ${c.hoursPct == null ? '' : bar(c.hoursPct, hoursLevel)}
                  <span class="nowrap ${hoursLevel === 'critical' ? 'over-plan' : ''}">${fmtHours(c.logged)}${c.planned ? ` / ${fmtHours(c.planned)}` : ''}</span>
                </td>
                <td data-label="Tasks done" class="meter-cell">
                  ${c.tasksPct == null ? '<span class="muted">No tasks</span>' : `${bar(c.tasksPct, 'progress')}<span>${c.tasksPct}%</span>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted small table-note">${shown.length} campaign${shown.length === 1 ? '' : 's'}. Bars turn amber at 80% of planned hours and red over plan.</p>`;

  list.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    if (filters.sort === button.dataset.sort) filters.dir = filters.dir === 'asc' ? 'desc' : 'asc';
    else {
      filters.sort = button.dataset.sort;
      filters.dir = ['name', 'owner', 'status'].includes(filters.sort) ? 'asc' : 'desc';
    }
    draw();
  }));
  // The whole row opens the campaign
  list.querySelectorAll('tr[data-href]').forEach(row => row.addEventListener('click', event => {
    if (!event.target.closest('a, button')) window.location.hash = row.dataset.href.slice(1);
  }));
}

// New campaign (campaign = null) or edit an existing one.
// onSaved receives the saved campaign row.
export function openCampaignForm(campaign, onSaved) {
  const c = campaign || { business_unit: 'education', status: 'planned', owner_id: state.me.id, planned_hours: 0 };
  const owners = state.people.filter(p => (p.active && p.role !== 'director') || p.id === c.owner_id);

  formDialog({
    title: campaign ? 'Edit campaign' : 'New campaign',
    submitLabel: campaign ? 'Save changes' : 'Create campaign',
    body: `
      <label class="field"><span>Name</span>
        <input name="name" required maxlength="200" value="${esc(c.name || '')}"></label>
      <label class="field"><span>Description</span>
        <textarea name="description" rows="3">${esc(c.description || '')}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Business unit</span>
          <select name="business_unit">${options(BUSINESS_UNITS, c.business_unit)}</select></label>
        <label class="field"><span>Status</span>
          <select name="status">${options(CAMPAIGN_STATUSES, c.status)}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Start date</span>
          <input type="date" name="start_date" required value="${esc(c.start_date || '')}"></label>
        <label class="field"><span>End date</span>
          <input type="date" name="end_date" required value="${esc(c.end_date || '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Owner</span>
          <select name="owner_id">
            <option value="">No owner</option>
            ${options(Object.fromEntries(owners.map(p => [p.id, p.name])), c.owner_id)}
          </select></label>
        <label class="field"><span>Planned hours</span>
          <input type="number" name="planned_hours" min="0" step="0.5" value="${esc(c.planned_hours ?? 0)}"></label>
      </div>`,
    onSubmit: async form => {
      const f = Object.fromEntries(new FormData(form));
      const values = {
        name: f.name.trim(),
        description: f.description.trim() || null,
        business_unit: f.business_unit,
        status: f.status,
        start_date: f.start_date || null,
        end_date: f.end_date || null,
        owner_id: f.owner_id || null,
        planned_hours: f.planned_hours === '' ? 0 : Number(f.planned_hours),
      };

      if (!values.name) return 'Give the campaign a name.';
      if (!values.start_date || !values.end_date) return 'Add a start and an end date.';
      if (values.end_date < values.start_date) return 'The end date must be on or after the start date.';
      if (!Number.isFinite(values.planned_hours) || values.planned_hours < 0) return 'Planned hours must be 0 or more.';

      const query = campaign
        ? supabase.from('campaigns').update(values).eq('id', campaign.id)
        : supabase.from('campaigns').insert(values);
      const { data, error } = await query.select().single();
      if (error) return errorMessage(error);

      toast(campaign ? 'Campaign updated' : 'Campaign created');
      onSaved?.(data);
    },
  });
}
