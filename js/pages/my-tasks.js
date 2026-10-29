import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { onTasksChanged, onLiveChange } from '../realtime.js';
import { updateTask, effectiveDue, dueGroup, isOverdue, todayIso, friendlyDue, DUE_GROUPS } from '../tasks.js';
import { weekMinutes, weekStart, addDays } from '../time.js';
import { availability, loadHolidays, loadTimeOff } from '../capacity.js';
import { startTimer } from '../timer.js';
import { esc, fmtDate, fmtHours, toast, errorMessage, TASK_STATUSES, BUSINESS_UNITS } from '../ui.js';
import { openTaskPanel } from './task-panel.js';

const SHOW_DONE_KEY = 'my-tasks-show-completed';
const COMPLETED_DAYS = 14;

function savedShowDone() {
  try { return localStorage.getItem(SHOW_DONE_KEY) === '1'; } catch { return false; }
}


// Home page: everything assigned to you (tasks and subtasks) across campaigns
export async function renderMyTasks(el) {
  const page = { el, items: [], showDone: savedShowDone(), ticking: false };

  el.innerHTML = `
    <div class="page-header my-tasks-header">
      <div>
        <h1>My tasks</h1>
        <p class="task-summary" data-summary></p>
      </div>
      <a class="week-card" href="#/my-time" data-week-card title="Open My time">
        <span class="muted small">Logged this week</span>
        <strong data-week-hours>…</strong>
        <span class="mini-meter" aria-hidden="true"><span data-week-bar style="width:0%"></span></span>
      </a>
    </div>
    <div class="list-toolbar">
      <label class="toggle">
        <input type="checkbox" data-show-done ${page.showDone ? 'checked' : ''}>
        Show completed (last ${COMPLETED_DAYS} days)
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

// Hours logged this week against the hours you're expected to work
// (your working days, minus bank holidays and time off)
async function loadWeekHours(el) {
  const start = weekStart(todayIso());
  const end = addDays(start, 6);
  try {
    const [minutes, holidays, timeOff] = await Promise.all([
      weekMinutes(state.me.id, start),
      loadHolidays(start, end),
      loadTimeOff({ from: start, to: end, personId: state.me.id }),
    ]);
    const logged = minutes / 60;
    const expected = availability(state.me, start, end, holidays, timeOff).hours;
    el.querySelector('[data-week-hours]').textContent = expected
      ? `${fmtHours(logged)} of ${fmtHours(expected)}` : fmtHours(logged);
    el.querySelector('[data-week-bar]').style.width = `${expected ? Math.min(100, logged / expected * 100) : 0}%`;
  } catch { /* leave the placeholder */ }
}

async function load(page) {
  const { data, error } = await supabase
    .from('tasks')
    .select(`id, title, status, due_date, parent_id, position, campaign_id, updated_at,
      campaign:campaigns(id, name, business_unit),
      parent:parent_id(id, title, due_date)`)
    .eq('assignee_id', state.me.id);
  if (error) {
    page.el.querySelector('[data-list]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  page.items = data.map(item => ({ ...item, due: effectiveDue(item, item.parent) }));
  draw(page);
}

function drawSummary(page, open) {
  const count = key => open.filter(i => dueGroup(i.due) === key).length;
  const parts = [
    count('overdue') && `<span class="summary-chip is-danger">${count('overdue')} overdue</span>`,
    count('today') && `<span class="summary-chip">${count('today')} due today</span>`,
    count('week') && `<span class="summary-chip">${count('week')} this week</span>`,
  ].filter(Boolean);
  page.el.querySelector('[data-summary]').innerHTML = parts.length
    ? parts.join('')
    : `<span class="muted">${open.length ? 'Nothing due this week.' : 'Nothing open assigned to you.'}</span>`;
}

function row(item) {
  const done = item.status === 'done';
  const late = isOverdue(item.due, item.status);
  return `
    <li class="my-task ${done ? 'is-done' : ''}" data-id="${esc(item.id)}" tabindex="0">
      <label class="tick" title="${done ? 'Mark as not done' : 'Mark as done'}">
        <input type="checkbox" data-done ${done ? 'checked' : ''} aria-label="Done: ${esc(item.title)}">
      </label>
      <div class="my-task-main">
        <span class="task-title">${item.parent ? '<span class="subtask-mark" title="Subtask" aria-label="Subtask">↳</span>' : ''}${esc(item.title)}</span>
        ${item.parent ? `<span class="parent-line">in ${esc(item.parent.title)}</span>` : ''}
      </div>
      <div class="my-task-campaign">
        <span class="campaign-name">${esc(item.campaign?.name || '')}</span>
        ${item.campaign ? `<span class="unit-line"><span class="unit-dot unit-dot-${esc(item.campaign.business_unit)}" aria-hidden="true"></span>${esc(BUSINESS_UNITS[item.campaign.business_unit])}</span>` : ''}
      </div>
      <span class="my-task-status"><span class="status status-task-${item.status}">${esc(TASK_STATUSES[item.status])}</span></span>
      <span class="due ${late ? 'overdue' : ''}" ${item.due ? `title="Due ${esc(fmtDate(item.due))}"` : ''}>${esc(friendlyDue(item.due, item.status))}</span>
      ${done ? '<span></span>' : `<button class="icon-btn row-timer" type="button" data-timer title="Start timer" aria-label="Start timer on ${esc(item.title)}">▶</button>`}
    </li>`;
}

function draw(page) {
  const list = page.el.querySelector('[data-list]');
  const open = page.items.filter(i => i.status !== 'done');
  const since = addDays(todayIso(), -COMPLETED_DAYS);
  const done = page.items.filter(i => i.status === 'done' && i.updated_at.slice(0, 10) >= since);
  drawSummary(page, open);

  if (!open.length && !(page.showDone && done.length)) {
    list.innerHTML = `<div class="empty-state"><p>${page.items.length
      ? 'All done. Nothing open is assigned to you.'
      : 'Nothing is assigned to you yet. Tasks assigned to you in any campaign will show up here.'}</p></div>`;
    return;
  }

  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);
  const groups = Object.entries(DUE_GROUPS)
    .map(([key, label]) => ({ key, label, items: open.filter(i => dueGroup(i.due) === key).sort(byDue) }))
    .filter(g => g.items.length);
  if (page.showDone && done.length) {
    groups.push({
      key: 'done',
      label: `Completed in the last ${COMPLETED_DAYS} days`,
      items: done.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    });
  }

  list.innerHTML = groups.map(group => `
    <section class="due-group due-group-${group.key}">
      <h2>${esc(group.label)} <span class="muted">${group.items.length}</span></h2>
      <ul class="my-task-list">${group.items.map(row).join('')}</ul>
    </section>`).join('');

  list.querySelectorAll('.my-task').forEach(li => {
    const item = page.items.find(i => i.id === li.dataset.id);
    // A subtask opens its main task's panel, with the subtask highlighted
    const openPanel = () => openTaskPanel(item.id);
    li.addEventListener('click', event => { if (!event.target.closest('input, label, button')) openPanel(); });
    li.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === li) openPanel(); });
    li.querySelector('[data-done]').addEventListener('change', event => tick(page, item, event.target.checked));
    li.querySelector('[data-timer]')?.addEventListener('click', () =>
      startTimer({ campaign_id: item.campaign_id, task_id: item.id }));
  });
}

// Tick done in place, with Undo. Unticking puts back the status it had.
async function tick(page, item, isDone) {
  const before = item.status;
  const next = isDone ? 'done' : (item.statusBeforeDone || 'todo');
  if (isDone) item.statusBeforeDone = before;
  item.status = next;
  page.ticking = true;
  try {
    await updateTask(item.id, { status: next });
    if (isDone) {
      toast(`Done: ${item.title}`, 'success', { action: { label: 'Undo', onClick: () => tick(page, item, false) } });
    }
  } catch (error) {
    item.status = before;
    toast(errorMessage(error), 'error');
  }
  setTimeout(() => {
    page.ticking = false;
    draw(page);
  }, isDone ? 600 : 0);
}
