import { supabase } from '../supabase.js';
import { state, canEditWork, personById } from '../state.js';
import { onTasksChanged } from '../realtime.js';
import { tasksDonePct } from '../tasks.js';
import {
  esc, options, buTag, statusPill, avatar, fmtDateRange, fmtHours, toast, errorMessage, formDialog,
  BUSINESS_UNITS, CAMPAIGN_STATUSES,
} from '../ui.js';

// Kept between visits so the list looks the same when coming back to it
const filters = { search: '', bu: '', status: '', owner: '' };

// Main tasks (not subtasks) of every campaign, for the "% of tasks done" column
async function loadTaskProgress() {
  const { data, error } = await supabase.from('tasks').select('campaign_id, parent_id, status').is('parent_id', null);
  if (error) throw error;
  const byCampaign = {};
  data.forEach(t => { (byCampaign[t.campaign_id] ||= []).push(t); });
  return Object.fromEntries(Object.entries(byCampaign).map(([id, tasks]) => [id, tasksDonePct(tasks)]));
}

export async function renderCampaigns(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Campaigns</h1>
      ${canEditWork() ? '<button class="btn btn-primary" type="button" data-new>New campaign</button>' : ''}
    </div>
    <div class="filters">
      <input class="search" type="search" placeholder="Search campaigns" aria-label="Search campaigns" value="${esc(filters.search)}">
      <select data-filter="bu" aria-label="Business unit">
        <option value="">All business units</option>${options(BUSINESS_UNITS, filters.bu)}
      </select>
      <select data-filter="status" aria-label="Status">
        <option value="">All statuses</option>${options(CAMPAIGN_STATUSES, filters.status)}
      </select>
      <select data-filter="owner" aria-label="Owner">
        <option value="">All owners</option>${options(Object.fromEntries(state.people.map(p => [p.id, p.name])), filters.owner)}
      </select>
      <button class="btn btn-ghost" type="button" data-clear>Clear</button>
    </div>
    <div data-list><p class="muted">Loading campaigns…</p></div>`;

  const list = el.querySelector('[data-list]');
  el.querySelector('[data-new]')?.addEventListener('click', () =>
    openCampaignForm(null, saved => { window.location.hash = `/campaigns/${saved.id}`; }));

  const [campaignResult, progressResult] = await Promise.allSettled([
    supabase.from('campaigns').select('*').order('start_date', { ascending: false, nullsFirst: false }).order('name'),
    loadTaskProgress(),
  ]);
  const error = campaignResult.reason || campaignResult.value?.error || progressResult.reason;
  if (error) {
    list.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const campaigns = campaignResult.value.data;
  let progress = progressResult.value;

  const draw = () => drawList(list, campaigns, progress);
  onTasksChanged(el, async () => {
    try {
      progress = await loadTaskProgress();
      draw();
    } catch { /* keep what's shown */ }
  });
  el.querySelector('.search').addEventListener('input', event => { filters.search = event.target.value; draw(); });
  el.querySelectorAll('[data-filter]').forEach(select =>
    select.addEventListener('change', () => { filters[select.dataset.filter] = select.value; draw(); }));
  el.querySelector('[data-clear]').addEventListener('click', () => {
    Object.keys(filters).forEach(k => { filters[k] = ''; });
    el.querySelector('.search').value = '';
    el.querySelectorAll('[data-filter]').forEach(select => { select.value = ''; });
    draw();
  });
  draw();
}

function matches(campaign) {
  const q = filters.search.trim().toLowerCase();
  return (!filters.bu || campaign.business_unit === filters.bu)
    && (!filters.status || campaign.status === filters.status)
    && (!filters.owner || campaign.owner_id === filters.owner)
    && (!q || `${campaign.name} ${campaign.description || ''}`.toLowerCase().includes(q));
}

function drawList(list, campaigns, progress) {
  if (!campaigns.length) {
    list.innerHTML = `<div class="empty-state"><p>No campaigns yet.${canEditWork() ? ' Create the first one with “New campaign”.' : ''}</p></div>`;
    return;
  }
  const shown = campaigns.filter(matches);
  if (!shown.length) {
    list.innerHTML = '<div class="empty-state"><p>No campaigns match these filters.</p></div>';
    return;
  }

  list.innerHTML = `
    <p class="muted count">${shown.length} of ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}</p>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Campaign</th><th>Business unit</th><th>Dates</th><th>Owner</th><th>Status</th>
            <th class="num">Hours logged / planned</th><th class="num">Tasks done</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(c => {
            const owner = personById(c.owner_id);
            const pct = progress[c.id] ?? null;
            return `
              <tr>
                <td><a class="row-link" href="#/campaigns/${esc(c.id)}">${esc(c.name)}</a></td>
                <td>${buTag(c.business_unit)}</td>
                <td class="nowrap">${esc(fmtDateRange(c.start_date, c.end_date))}</td>
                <td>${owner ? `<span class="person">${avatar(owner, 24)}${esc(owner.name)}</span>` : '<span class="muted">—</span>'}</td>
                <td>${statusPill(c.status)}</td>
                <td class="num nowrap">${fmtHours(0)} / ${fmtHours(c.planned_hours)}</td>
                <td class="num">${pct == null ? '<span class="muted">—</span>' : `${pct}%`}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
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
