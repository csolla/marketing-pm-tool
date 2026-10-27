import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/+esm';
import { supabase } from '../supabase.js';
import { canEditWork, isAdmin, personById } from '../state.js';
import { onTasksChanged } from '../realtime.js';
import {
  loadCampaignTasks, createTask, updateTask, positionBetween, byPosition, tasksDonePct, isOverdue,
} from '../tasks.js';
import {
  esc, options, buTag, statusPill, avatar, fmtDateRange, fmtShortDate, fmtHours, toast, errorMessage,
  confirmDialog, TASK_STATUSES,
} from '../ui.js';
import { openCampaignForm } from './campaigns.js';
import { openTaskPanel } from './task-panel.js';

const VIEW_KEY = 'campaign-view';

function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

export async function renderCampaign(el, id) {
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

  const owner = personById(campaign.owner_id);
  const page = { el, campaign, tasks: tasksResult.value, view: savedView(), dragging: false };

  el.innerHTML = `
    <a class="back-link" href="#/campaigns">← Campaigns</a>
    <section class="card campaign-head">
      <div class="campaign-title">
        <div>
          <div class="tags">${buTag(campaign.business_unit)} ${statusPill(campaign.status)}</div>
          <h1>${esc(campaign.name)}</h1>
        </div>
        <div class="actions">
          ${canEditWork() ? '<button class="btn" type="button" data-edit>Edit</button>' : ''}
          ${isAdmin() ? '<button class="btn btn-danger-outline" type="button" data-delete>Delete</button>' : ''}
        </div>
      </div>
      ${campaign.description
        ? `<p class="description">${esc(campaign.description)}</p>`
        : '<p class="muted">No description.</p>'}
      <dl class="details">
        <div><dt>Dates</dt><dd>${esc(fmtDateRange(campaign.start_date, campaign.end_date))}</dd></div>
        <div><dt>Owner</dt><dd>${owner ? `<span class="person">${avatar(owner, 24)}${esc(owner.name)}</span>` : '—'}</dd></div>
        <div><dt>Hours logged / planned</dt><dd>${fmtHours(0)} / ${fmtHours(campaign.planned_hours)}</dd></div>
        <div><dt>Tasks done</dt><dd data-progress></dd></div>
      </dl>
    </section>
    <section class="section">
      <div class="tasks-toolbar">
        <h2>Tasks</h2>
        <form class="quick-add" data-quick-add>
          <input placeholder="Add a task and press Enter" aria-label="New task title" maxlength="300">
        </form>
        <div class="view-switch" role="group" aria-label="View">
          <button type="button" data-view="board">Board</button>
          <button type="button" data-view="list">List</button>
        </div>
      </div>
      <div data-tasks></div>
    </section>`;

  el.querySelector('[data-edit]')?.addEventListener('click', () =>
    openCampaignForm(campaign, () => renderCampaign(el, id)));
  el.querySelector('[data-delete]')?.addEventListener('click', () => deleteCampaign(page));
  el.querySelector('[data-quick-add]').addEventListener('submit', event => quickAdd(event, page));
  el.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    page.view = button.dataset.view;
    try { localStorage.setItem(VIEW_KEY, page.view); } catch { /* not saved; fine */ }
    drawTasks(page);
  }));

  drawTasks(page);

  onTasksChanged(el, async () => {
    try {
      page.tasks = await loadCampaignTasks(id);
      drawTasks(page);
    } catch { /* keep what's shown */ }
  }, { isBusy: () => page.dragging });
}

function drawTasks(page) {
  const { el, tasks, view } = page;
  const pct = tasksDonePct(tasks);
  el.querySelector('[data-progress]').textContent = pct == null ? '—' : `${pct}%`;
  el.querySelectorAll('[data-view]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.view === view)));

  const container = el.querySelector('[data-tasks]');
  const main = tasks.filter(t => !t.parent_id);
  const subtasksOf = id => tasks.filter(t => t.parent_id === id);

  if (!main.length) {
    container.innerHTML = '<div class="empty-state"><p>No tasks yet. Type a title above and press Enter to add the first one.</p></div>';
    return;
  }
  if (view === 'list') drawList(page, container, main, subtasksOf);
  else drawBoard(page, container, main, subtasksOf);
}

function subtaskCount(subtasks) {
  if (!subtasks.length) return '';
  const done = subtasks.filter(s => s.status === 'done').length;
  return `<span class="subcount" title="Subtasks done">✓ ${done}/${subtasks.length}</span>`;
}

function dueLabel(task) {
  if (!task.due_date) return '';
  const late = isOverdue(task.due_date, task.status);
  return `<span class="due ${late ? 'overdue' : ''}" title="${late ? 'Overdue' : 'Due date'}">${esc(fmtShortDate(task.due_date))}</span>`;
}

// Board ---------------------------------------------------------------------

function drawBoard(page, container, main, subtasksOf) {
  container.innerHTML = `
    <div class="board">
      ${Object.entries(TASK_STATUSES).map(([status, label]) => {
        const column = main.filter(t => t.status === status).sort(byPosition);
        return `
          <section class="board-col">
            <header class="board-col-head"><h3>${esc(label)}</h3><span class="muted">${column.length}</span></header>
            <div class="board-cards" data-status="${status}">
              ${column.map(task => {
                const assignee = personById(task.assignee_id);
                return `
                  <article class="task-card ${status === 'done' ? 'is-done' : ''}" data-id="${esc(task.id)}" tabindex="0">
                    <p class="task-card-title">${esc(task.title)}</p>
                    <div class="task-card-meta">
                      ${dueLabel(task)}
                      ${subtaskCount(subtasksOf(task.id))}
                      <span class="spacer"></span>
                      ${assignee ? `<span title="${esc(assignee.name)}">${avatar(assignee, 24)}</span>` : ''}
                    </div>
                  </article>`;
              }).join('')}
            </div>
          </section>`;
      }).join('')}
    </div>`;

  container.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => openTaskPanel(card.dataset.id));
    card.addEventListener('keydown', event => { if (event.key === 'Enter') openTaskPanel(card.dataset.id); });
  });

  container.querySelectorAll('.board-cards').forEach(column => Sortable.create(column, {
    group: 'tasks',
    animation: 150,
    delayOnTouchOnly: true,
    delay: 150,
    ghostClass: 'drag-ghost',
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
                <td><span class="task-title">${esc(task.title)}</span> ${subtaskCount(subtasksOf(task.id))}</td>
                <td>${assignee ? `<span class="person">${avatar(assignee, 24)}${esc(assignee.name)}</span>` : '<span class="muted">—</span>'}</td>
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

// Quick add and campaign delete --------------------------------------------

async function quickAdd(event, page) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';

  const todo = page.tasks.filter(t => !t.parent_id && t.status === 'todo');
  const last = Math.max(0, ...todo.map(t => t.position));
  try {
    const task = await createTask({ campaign_id: page.campaign.id, title, status: 'todo', position: last + 1000 });
    if (!page.tasks.some(t => t.id === task.id)) page.tasks.push(task);
    drawTasks(page);
  } catch (error) {
    input.value = title;
    toast(errorMessage(error), 'error');
  }
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
