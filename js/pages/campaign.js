import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/+esm';
import { supabase } from '../supabase.js';
import { state, canEditWork, isAdmin, personById } from '../state.js';
import { onTasksChanged, onLiveChange } from '../realtime.js';
import { loadCampaignHours } from '../time.js';
import {
  loadCampaignTasks, createTask, updateTask, positionBetween, byPosition, tasksDonePct, isOverdue, friendlyDue,
} from '../tasks.js';
import {
  esc, options, statusPill, avatar, fmtCompactRange, fmtDate, fmtHours, toast, errorMessage,
  confirmDialog, TASK_STATUSES, BUSINESS_UNITS,
} from '../ui.js';
import { openCampaignForm } from './campaigns.js';
import { openTaskPanel } from './task-panel.js';

const VIEW_KEY = 'campaign-view';
const DONE_SHOWN = 10;

// Per campaign, for this visit: filters and the quick-add assignee/date
const memory = {};

function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

// openTask: a task to open straight away (from a shared task link)
export async function renderCampaign(el, id, openTask = null) {
  el.innerHTML = '<p class="muted">Loading campaign…</p>';

  const [campaignResult, tasksResult] = await Promise.allSettled([
    supabase.from('campaigns').select('*').eq('id', id).maybeSingle(),
    loadCampaignTasks(id),
  ]);
  const error = campaignResult.reason || campaignResult.value?.error || tasksResult.reason;
  if (error) {
    el.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const campaign = campaignResult.value.data;
  if (!campaign) {
    el.innerHTML = `
      <a class="back-link" href="#/campaigns">← Campaigns</a>
      <div class="empty-state"><p>This campaign doesn't exist or was deleted.</p></div>`;
    return;
  }

  memory[id] ||= { q: '', person: '', assignee: '', due: '', showAllDone: false, details: false };
  const page = { el, campaign, tasks: tasksResult.value, view: savedView(), dragging: false, counts: {}, m: memory[id] };
  const owner = personById(campaign.owner_id);
  const team = state.people.filter(p => p.active && p.role !== 'director');

  el.innerHTML = `
    <a class="back-link" href="#/campaigns">← Campaigns</a>
    <section class="card campaign-summary">
      <div class="summary-top">
        <div class="summary-title">
          <h1>${esc(campaign.name)}</h1>
          <div class="summary-meta">
            <span class="unit-line"><span class="unit-dot unit-dot-${esc(campaign.business_unit)}" aria-hidden="true"></span>${esc(BUSINESS_UNITS[campaign.business_unit])}</span>
            ${statusPill(campaign.status)}
            <span>${esc(fmtCompactRange(campaign.start_date, campaign.end_date))}</span>
            ${owner ? `<span class="person">${avatar(owner, 20)}${esc(owner.name)}</span>` : ''}
          </div>
        </div>
        <div class="summary-stats">
          <div class="stat"><span class="stat-label">Hours</span><span data-hours>…</span></div>
          <div class="stat"><span class="stat-label">Tasks done</span><span data-progress></span></div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost btn-small" type="button" data-toggle-details aria-expanded="${page.m.details}">Details</button>
          ${canEditWork() ? '<button class="btn btn-small" type="button" data-edit>Edit</button>' : ''}
        </div>
      </div>
      <div class="campaign-details" data-details ${page.m.details ? '' : 'hidden'}>
        ${campaign.description ? `<p class="description">${esc(campaign.description)}</p>` : '<p class="muted">No description.</p>'}
        <p class="muted small">${esc(fmtDate(campaign.start_date))}${campaign.end_date ? ` to ${esc(fmtDate(campaign.end_date))}` : ''} · Planned ${fmtHours(campaign.planned_hours)}</p>
        ${isAdmin() ? `
          <div class="details-actions">
            <button class="btn btn-small btn-danger-outline" type="button" data-delete hidden>Delete campaign</button>
            <span class="muted small" data-delete-note hidden>This campaign has hours logged, so it can't be deleted. Set it to Done or On hold instead.</span>
          </div>` : ''}
      </div>
    </section>
    <section class="section tasks-section">
      ${canEditWork() ? `
        <form class="quick-add-bar" data-quick-add>
          <input class="quick-title" placeholder="Add a task and press Enter" aria-label="New task title" maxlength="300">
          <select data-qa="assignee" aria-label="Assign new tasks to">
            <option value="">Unassigned</option>
            ${options(Object.fromEntries(team.map(p => [p.id, p.id === state.me.id ? `${p.name} (me)` : p.name])), page.m.assignee)}
          </select>
          <input type="date" data-qa="due" value="${esc(page.m.due)}" aria-label="Due date for new tasks">
          <button class="btn btn-primary" type="submit">Add</button>
        </form>` : ''}
      <div class="tasks-toolbar">
        <input class="search" type="search" placeholder="Find a task" aria-label="Find a task" value="${esc(page.m.q)}" data-find>
        <select data-person aria-label="Show tasks for">
          <option value="">Everyone</option>
          <option value="me" ${page.m.person === 'me' ? 'selected' : ''}>Only mine</option>
          <option value="none" ${page.m.person === 'none' ? 'selected' : ''}>Unassigned</option>
          ${options(Object.fromEntries(team.filter(p => p.id !== state.me.id).map(p => [p.id, p.name])), page.m.person)}
        </select>
        <span class="spacer"></span>
        <div class="view-switch" role="group" aria-label="View">
          <button type="button" data-view="board">Board</button>
          <button type="button" data-view="list">List</button>
        </div>
      </div>
      <div data-tasks></div>
    </section>`;

  el.querySelector('[data-toggle-details]').addEventListener('click', event => {
    page.m.details = !page.m.details;
    event.currentTarget.setAttribute('aria-expanded', String(page.m.details));
    el.querySelector('[data-details]').hidden = !page.m.details;
  });
  el.querySelector('[data-edit]')?.addEventListener('click', () =>
    openCampaignForm(campaign, () => renderCampaign(el, id)));
  el.querySelector('[data-delete]')?.addEventListener('click', () => deleteCampaign(page));
  const quick = el.querySelector('[data-quick-add]');
  if (quick) {
    quick.addEventListener('submit', event => quickAdd(event, page));
    quick.querySelectorAll('[data-qa]').forEach(input => input.addEventListener('change', () => {
      page.m[input.dataset.qa] = input.value;
    }));
  }
  el.querySelector('[data-find]').addEventListener('input', event => { page.m.q = event.target.value; drawTasks(page); });
  el.querySelector('[data-person]').addEventListener('change', event => { page.m.person = event.target.value; drawTasks(page); });
  el.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    page.view = button.dataset.view;
    try { localStorage.setItem(VIEW_KEY, page.view); } catch { /* not saved; fine */ }
    drawTasks(page);
  }));

  drawTasks(page);
  loadHours(page);
  loadCounts(page);
  if (openTask) openTaskPanel(openTask);
  onLiveChange(el, ['comments-changed', 'attachments-changed'], () => loadCounts(page), { isBusy: () => page.dragging });
  onLiveChange(el, 'time-changed', () => loadHours(page));

  onTasksChanged(el, async () => {
    try {
      page.tasks = await loadCampaignTasks(id);
      drawTasks(page);
    } catch { /* keep what's shown */ }
  }, { isBusy: () => page.dragging || page.el.contains(document.activeElement) && document.activeElement.matches('.column-add input') });
}

function meter(pct, level) {
  return `<span class="mini-meter meter-${level}" aria-hidden="true"><span style="width:${Math.min(100, pct)}%"></span></span>`;
}

// Hours logged, with the Education / Planning Center split for Shared campaigns.
// Campaigns with hours can't be deleted.
async function loadHours(page) {
  const { el, campaign } = page;
  let totals;
  try {
    totals = (await loadCampaignHours(campaign.id))[campaign.id];
  } catch {
    return;
  }
  const hours = Number(totals?.hours || 0);
  const planned = Number(campaign.planned_hours);
  const pct = planned > 0 ? hours / planned * 100 : null;
  const level = pct == null ? 'none' : pct > 100 ? 'critical' : pct >= 80 ? 'warning' : 'good';
  const split = campaign.business_unit === 'shared' && hours
    ? `<span class="muted small hours-split">${fmtHours(totals.education_hours)} Education · ${fmtHours(totals.planning_center_hours)} Planning Center</span>`
    : '';
  el.querySelector('[data-hours]').innerHTML = `
    <span class="stat-value">${pct == null ? '' : meter(pct, level)}
      <span class="${level === 'critical' ? 'over-plan' : ''}">${fmtHours(hours)}</span>${planned ? ` <span class="muted">of ${fmtHours(planned)}</span>` : ''}</span>${split}`;
  const remove = el.querySelector('[data-delete]');
  if (remove) {
    remove.hidden = hours > 0;
    el.querySelector('[data-delete-note]').hidden = hours === 0;
  }
}

// Filters: words in the task or its subtasks; a person as assignee of the
// task or any of its subtasks
function matches(page, task, subtasks) {
  const q = page.m.q.trim().toLowerCase();
  const person = page.m.person === 'me' ? state.me.id : page.m.person;
  const textOk = !q || [task, ...subtasks].some(t => t.title.toLowerCase().includes(q));
  if (!person) return textOk;
  if (person === 'none') return textOk && !task.assignee_id;
  return textOk && [task, ...subtasks].some(t => t.assignee_id === person);
}

function drawTasks(page) {
  const { el, tasks, view } = page;
  const main = tasks.filter(t => !t.parent_id);
  const pct = tasksDonePct(tasks);
  const done = main.filter(t => t.status === 'done').length;
  el.querySelector('[data-progress]').innerHTML = pct == null
    ? '<span class="muted">No tasks yet</span>'
    : `<span class="stat-value">${meter(pct, 'progress')} ${done} of ${main.length} <span class="muted">(${pct}%)</span></span>`;
  el.querySelectorAll('[data-view]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.view === view)));

  const container = el.querySelector('[data-tasks]');
  const subtasksOf = id => tasks.filter(t => t.parent_id === id);
  if (!main.length) {
    container.innerHTML = `<div class="empty-state"><p>No tasks yet.${canEditWork() ? ' Type a title above and press Enter to add the first one.' : ''}</p></div>`;
    return;
  }
  const filtering = Boolean(page.m.q.trim() || page.m.person);
  const shown = main.filter(t => matches(page, t, subtasksOf(t.id)));
  if (!shown.length) {
    container.innerHTML = '<div class="empty-state"><p>No tasks match. Change the person or clear the search.</p></div>';
    return;
  }
  if (view === 'list') drawList(page, container, shown, subtasksOf);
  else drawBoard(page, container, shown, subtasksOf, filtering);
}

// Comment and attachment counts for the cards
async function loadCounts(page) {
  const { data, error } = await supabase.from('task_activity_counts')
    .select('task_id, comments, attachments').eq('campaign_id', page.campaign.id);
  if (error) return;
  page.counts = Object.fromEntries(data.map(row => [row.task_id, row]));
  drawTasks(page);
}

const ICONS = {
  comments: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  attachments: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 5 6 9.5a1.4 1.4 0 0 0 2 2L13 6.5a2.8 2.8 0 0 0-4-4L4 7.5a4.2 4.2 0 0 0 6 6l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

function activityCounts(page, taskId) {
  const counts = page.counts[taskId];
  if (!counts) return '';
  const item = (key, label) => (Number(counts[key])
    ? `<span class="activity-count" title="${counts[key]} ${label}">${ICONS[key]}${counts[key]}</span>` : '');
  return item('comments', 'comments') + item('attachments', 'attachments');
}

function subtaskCount(subtasks) {
  if (!subtasks.length) return '';
  const done = subtasks.filter(s => s.status === 'done').length;
  return `<span class="subcount" title="Subtasks done">✓ ${done}/${subtasks.length}</span>`;
}

function dueLabel(task) {
  if (!task.due_date) return '';
  const late = isOverdue(task.due_date, task.status);
  return `<span class="due ${late ? 'overdue' : ''}" title="Due ${esc(fmtDate(task.due_date))}">${esc(friendlyDue(task.due_date, task.status))}</span>`;
}

function assigneeBadge(task, size = 24) {
  const assignee = personById(task.assignee_id);
  return assignee
    ? `<span title="${esc(assignee.name)}">${avatar(assignee, size)}</span>`
    : `<span class="avatar avatar-empty" style="width:${size}px;height:${size}px" title="Unassigned" aria-label="Unassigned"></span>`;
}

// Board ---------------------------------------------------------------------

function drawBoard(page, container, main, subtasksOf, filtering) {
  container.innerHTML = `
    <div class="board">
      ${Object.entries(TASK_STATUSES).map(([status, label]) => {
        let column = main.filter(t => t.status === status).sort(byPosition);
        const total = column.length;
        // Done keeps growing: show the most recently finished unless asked for all
        let hidden = 0;
        if (status === 'done' && !filtering && !page.m.showAllDone && total > DONE_SHOWN) {
          const recent = new Set([...column].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, DONE_SHOWN).map(t => t.id));
          column = column.filter(t => recent.has(t.id));
          hidden = total - DONE_SHOWN;
        }
        return `
          <section class="board-col">
            <header class="board-col-head"><h3>${esc(label)}</h3><span class="muted">${total}</span></header>
            <div class="board-cards" data-status="${status}">
              ${column.map(task => `
                <article class="task-card ${status === 'done' ? 'is-done' : ''}" data-id="${esc(task.id)}" tabindex="0">
                  <p class="task-card-title">${esc(task.title)}</p>
                  <div class="task-card-meta">
                    ${dueLabel(task)}
                    ${subtaskCount(subtasksOf(task.id))}
                    ${activityCounts(page, task.id)}
                    <span class="spacer"></span>
                    ${assigneeBadge(task)}
                  </div>
                </article>`).join('')}
            </div>
            ${hidden ? `<button class="btn btn-ghost btn-small column-more" type="button" data-show-done>Show all ${total} done</button>` : ''}
            ${status === 'done' && page.m.showAllDone && total > DONE_SHOWN && !filtering
              ? '<button class="btn btn-ghost btn-small column-more" type="button" data-hide-done>Show only the latest</button>' : ''}
            ${canEditWork() ? `<form class="column-add" data-column-add="${status}">
              <button class="btn btn-ghost btn-small column-add-open" type="button">+ Add task</button>
              <input placeholder="Task title, then Enter" aria-label="New task in ${esc(label)}" maxlength="300" hidden>
            </form>` : ''}
          </section>`;
      }).join('')}
    </div>`;

  container.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => openTaskPanel(card.dataset.id));
    card.addEventListener('keydown', event => { if (event.key === 'Enter') openTaskPanel(card.dataset.id); });
  });
  container.querySelector('[data-show-done]')?.addEventListener('click', () => { page.m.showAllDone = true; drawTasks(page); });
  container.querySelector('[data-hide-done]')?.addEventListener('click', () => { page.m.showAllDone = false; drawTasks(page); });

  container.querySelectorAll('[data-column-add]').forEach(form => {
    const open = form.querySelector('.column-add-open');
    const input = form.querySelector('input');
    const close = () => { input.hidden = true; open.hidden = false; input.value = ''; };
    open.addEventListener('click', () => { open.hidden = true; input.hidden = false; input.focus(); });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
    input.addEventListener('blur', () => { if (!input.value.trim()) close(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      await addTask(page, title, form.dataset.columnAdd);
      // Keep the box open in the same column for the next one
      container.querySelector(`[data-column-add="${form.dataset.columnAdd}"] .column-add-open`)?.click();
    });
  });

  container.querySelectorAll('.board-cards').forEach(column => Sortable.create(column, {
    group: 'tasks',
    animation: 150,
    delayOnTouchOnly: true,
    delay: 150,
    ghostClass: 'drag-ghost',
    disabled: !canEditWork(),
    onStart: () => { page.dragging = true; },
    onEnd: event => moveTask(page, event),
  }));
}

async function moveTask(page, event) {
  page.dragging = false;
  if (event.from === event.to && event.oldIndex === event.newIndex) return;

  const task = page.tasks.find(t => t.id === event.item.dataset.id);
  const positionOf = node => (node ? page.tasks.find(t => t.id === node.dataset.id)?.position : null);
  const status = event.to.dataset.status;
  const position = positionBetween(positionOf(event.item.previousElementSibling), positionOf(event.item.nextElementSibling));
  const before = { status: task.status, position: task.position };

  Object.assign(task, { status, position });
  setTimeout(() => drawTasks(page), 0);
  try {
    await updateTask(task.id, { status, position });
  } catch (error) {
    Object.assign(task, before);
    drawTasks(page);
    toast(errorMessage(error), 'error');
  }
}

// List ----------------------------------------------------------------------

const STATUS_ORDER = Object.keys(TASK_STATUSES);

function drawList(page, container, main, subtasksOf) {
  const sorted = [...main].sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byPosition(a, b));

  container.innerHTML = `
    <div class="table-wrap">
      <table class="table task-table">
        <thead>
          <tr><th class="tick-col"><span class="visually-hidden">Done</span></th><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${sorted.map(task => {
            const assignee = personById(task.assignee_id);
            return `
              <tr data-id="${esc(task.id)}" class="clickable ${task.status === 'done' ? 'is-done' : ''}">
                <td class="tick-col"><input type="checkbox" data-done ${task.status === 'done' ? 'checked' : ''} aria-label="Done"></td>
                <td><span class="task-title">${esc(task.title)}</span> ${subtaskCount(subtasksOf(task.id))} ${activityCounts(page, task.id)}</td>
                <td>${assignee ? `<span class="person">${avatar(assignee, 24)}${esc(assignee.name)}</span>` : `<span class="person">${assigneeBadge(task)}<span class="muted">Unassigned</span></span>`}</td>
                <td class="nowrap">${dueLabel(task) || '<span class="muted">—</span>'}</td>
                <td><select data-status aria-label="Status">${options(TASK_STATUSES, task.status)}</select></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  container.querySelectorAll('tbody tr').forEach(row => {
    const task = page.tasks.find(t => t.id === row.dataset.id);
    row.addEventListener('click', event => {
      if (!event.target.closest('input, select')) openTaskPanel(task.id);
    });
    row.querySelector('[data-done]').addEventListener('change', event =>
      setStatus(page, task, event.target.checked ? 'done' : 'todo'));
    row.querySelector('[data-status]').addEventListener('change', event => setStatus(page, task, event.target.value));
  });
}

async function setStatus(page, task, status) {
  const before = task.status;
  task.status = status;
  drawTasks(page);
  try {
    await updateTask(task.id, { status });
  } catch (error) {
    task.status = before;
    drawTasks(page);
    toast(errorMessage(error), 'error');
  }
}

// Adding tasks ----------------------------------------------------------------

// New tasks go to the bottom of their column, with the quick-add
// assignee and due date
async function addTask(page, title, status) {
  const column = page.tasks.filter(t => !t.parent_id && t.status === status);
  const last = Math.max(0, ...column.map(t => t.position));
  try {
    const task = await createTask({
      campaign_id: page.campaign.id,
      title,
      status,
      position: last + 1000,
      assignee_id: page.m.assignee || null,
      due_date: page.m.due || null,
    });
    if (!page.tasks.some(t => t.id === task.id)) page.tasks.push(task);
    drawTasks(page);
    return true;
  } catch (error) {
    toast(errorMessage(error), 'error');
    return false;
  }
}

async function quickAdd(event, page) {
  event.preventDefault();
  const input = event.target.querySelector('.quick-title');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  if (!(await addTask(page, title, 'todo'))) input.value = title;
  input.focus();
}

async function deleteCampaign(page) {
  const { campaign, tasks } = page;
  const count = tasks.length;
  const ok = await confirmDialog({
    title: 'Delete campaign?',
    message: `“${campaign.name}”${count ? ` and its ${count} task${count === 1 ? '' : 's'}` : ''} will be deleted for everyone. This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.from('campaigns').delete().eq('id', campaign.id);
  if (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  toast('Campaign deleted');
  window.location.hash = '/campaigns';
}
