import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { onTasksChanged, onLiveChange } from '../realtime.js';
import { updateTask, effectiveDue, dueGroup, isOverdue, todayIso, DUE_GROUPS } from '../tasks.js';
import { weekMinutes, weekStart } from '../time.js';
import { esc, buTag, fmtShortDate, fmtHours, toast, errorMessage } from '../ui.js';
import { openTaskPanel } from './task-panel.js';

const SHOW_DONE_KEY = 'my-tasks-show-completed';

function savedShowDone() {
  try { return localStorage.getItem(SHOW_DONE_KEY) === '1'; } catch { return false; }
}

// Home page: everything assigned to you (tasks and subtasks) across campaigns
export async function renderMyTasks(el) {
  const page = { el, items: [], showDone: savedShowDone(), ticking: false };

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1>My tasks</h1>
        <a class="week-hours" href="#/my-time" data-week-hours>Hours this week: …</a>
      </div>
      <label class="toggle">
        <input type="checkbox" data-show-done ${page.showDone ? 'checked' : ''}>
        Show completed
      </label>
    </div>
    <div data-list><p class="muted">Loading your tasks…</p></div>`;

  el.querySelector('[data-show-done]').addEventListener('change', event => {
    page.showDone = event.target.checked;
    try { localStorage.setItem(SHOW_DONE_KEY, page.showDone ? '1' : '0'); } catch { /* not saved; fine */ }
    draw(page);
  });

  loadWeekHours(el);
  onLiveChange(el, 'time-changed', () => loadWeekHours(el));
  await load(page);
  onTasksChanged(el, () => load(page), { isBusy: () => page.ticking });
}

async function loadWeekHours(el) {
  try {
    const minutes = await weekMinutes(state.me.id, weekStart(todayIso()));
    el.querySelector('[data-week-hours]').textContent = `Hours this week: ${fmtHours(minutes / 60)}`;
  } catch { /* leave the placeholder */ }
}

async function load(page) {
  const { data, error } = await supabase
    .from('tasks')
    .select(`id, title, status, due_date, parent_id, position,
      campaign:campaigns(id, name, business_unit),
      parent:tasks!tasks_parent_id_fkey(id, title, due_date)`)
    .eq('assignee_id', state.me.id);
  if (error) {
    page.el.querySelector('[data-list]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  page.items = data.map(item => ({ ...item, due: effectiveDue(item, item.parent) }));
  draw(page);
}

function draw(page) {
  const list = page.el.querySelector('[data-list]');
  const open = page.items.filter(i => i.status !== 'done');
  const done = page.items.filter(i => i.status === 'done');

  if (!open.length && !(page.showDone && done.length)) {
    list.innerHTML = `<div class="empty-state"><p>${done.length
      ? 'All done. Nothing open is assigned to you.'
      : 'Nothing is assigned to you yet. Tasks assigned to you in any campaign will show up here.'}</p></div>`;
    return;
  }

  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);
  const groups = Object.entries(DUE_GROUPS)
    .map(([key, label]) => ({ key, label, items: open.filter(i => dueGroup(i.due) === key).sort(byDue) }))
    .filter(g => g.items.length);
  if (page.showDone && done.length) {
    groups.push({ key: 'done', label: 'Completed', items: done.sort(byDue).reverse() });
  }

  list.innerHTML = groups.map(group => `
    <section class="due-group due-group-${group.key}">
      <h2>${esc(group.label)} <span class="muted">${group.items.length}</span></h2>
      <ul class="my-task-list">
        ${group.items.map(item => `
          <li class="my-task ${item.status === 'done' ? 'is-done' : ''}" data-id="${esc(item.id)}" tabindex="0">
            <input type="checkbox" data-done ${item.status === 'done' ? 'checked' : ''} aria-label="Done">
            <div class="my-task-main">
              <span class="task-title">${esc(item.title)}</span>
              ${item.parent ? `<span class="muted small">Subtask of ${esc(item.parent.title)}</span>` : ''}
            </div>
            <span class="my-task-campaign">${esc(item.campaign?.name || '')}</span>
            ${item.campaign ? buTag(item.campaign.business_unit) : ''}
            <span class="due ${isOverdue(item.due, item.status) ? 'overdue' : ''}">${item.due ? esc(fmtShortDate(item.due)) : ''}</span>
          </li>`).join('')}
      </ul>
    </section>`).join('');

  list.querySelectorAll('.my-task').forEach(row => {
    const item = page.items.find(i => i.id === row.dataset.id);
    const open = () => openTaskPanel(item.parent_id || item.id);
    row.addEventListener('click', event => { if (!event.target.closest('input')) open(); });
    row.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === row) open(); });
    row.querySelector('[data-done]').addEventListener('change', event => tick(page, item, event.target.checked));
  });
}

// Tick done in place. The row stays a moment so the change is visible.
async function tick(page, item, isDone) {
  const before = item.status;
  item.status = isDone ? 'done' : 'todo';
  page.ticking = true;
  try {
    await updateTask(item.id, { status: item.status });
    if (isDone) toast(`Done: ${item.title}`);
  } catch (error) {
    item.status = before;
    toast(errorMessage(error), 'error');
  }
  setTimeout(() => {
    page.ticking = false;
    draw(page);
  }, isDone ? 600 : 0);
}
