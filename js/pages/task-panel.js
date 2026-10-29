import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { onTasksChanged, onLiveChange } from '../realtime.js';
import { createTask, updateTask, deleteTask, byPosition } from '../tasks.js';
import { loadTasksHours } from '../time.js';
import { startTimer } from '../timer.js';
import { esc, options, buTag, fmtHours, toast, errorMessage, confirmDialog, TASK_STATUSES } from '../ui.js';
import { openTimeEntryForm } from './time-entry-form.js';
import { mountAttachments, mountComments } from './task-discussion.js';

// The task side panel. One at a time, opened from the campaign board/list
// and from My tasks. Every field saves when you leave it.
let current = null;

// highlight: a subtask to point out once the panel is open
export async function openTaskPanel(taskId, { highlight = null } = {}) {
  closeTaskPanel();

  const backdrop = document.createElement('div');
  backdrop.className = 'panel-backdrop';
  const panel = document.createElement('aside');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Task');
  panel.innerHTML = '<p class="muted panel-loading">Loading task…</p>';
  document.body.append(backdrop, panel);
  requestAnimationFrame(() => panel.classList.add('open'));
  backdrop.addEventListener('click', closeTaskPanel);

  current = { taskId, panel, backdrop, task: null, subtasks: [], highlight };
  const mine = current;

  let data;
  try {
    data = await loadTask(taskId);
  } catch (error) {
    panel.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  if (current !== mine) return;
  if (!data) {
    closeTaskPanel();
    toast('That task no longer exists.', 'error');
    return;
  }
  // Subtasks open in their parent task's panel
  if (data.task.parent_id) {
    openTaskPanel(data.task.parent_id, { highlight: data.task.id });
    return;
  }

  Object.assign(current, data);
  render();
  onTasksChanged(panel, refresh, { delay: 300 });
  onLiveChange(panel, 'time-changed', loadHours, { delay: 300 });
  loadHours();
}

export function closeTaskPanel() {
  if (!current) return;
  const { panel, backdrop } = current;
  current = null;
  panel.classList.remove('open');
  backdrop.remove();
  setTimeout(() => panel.remove(), 200);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && current && !document.querySelector('dialog[open]')) closeTaskPanel();
});
window.addEventListener('hashchange', closeTaskPanel);

async function loadTask(taskId) {
  const { data: task, error } = await supabase
    .from('tasks').select('*, campaign:campaigns(id, name, business_unit)').eq('id', taskId).maybeSingle();
  if (error) throw error;
  if (!task) return null;
  const { data: subtasks, error: subError } = await supabase.from('tasks').select('*').eq('parent_id', taskId);
  if (subError) throw subError;
  return { task, subtasks: subtasks.sort(byPosition) };
}

// People who can be assigned work, plus whoever is assigned already
function assigneeOptions(selectedId) {
  const people = state.people.filter(p => (p.active && p.role !== 'director') || p.id === selectedId);
  return `<option value="">Unassigned</option>${options(Object.fromEntries(people.map(p => [p.id, p.name])), selectedId)}`;
}

function render() {
  const { panel, task } = current;
  panel.innerHTML = `
    <header class="panel-header">
      <a class="panel-campaign" href="#/campaigns/${esc(task.campaign.id)}">
        ${buTag(task.campaign.business_unit)} <span>${esc(task.campaign.name)}</span>
      </a>
      <div class="panel-actions">
        <button class="btn btn-small btn-danger-outline" type="button" data-delete>Delete</button>
        <button class="icon-btn" type="button" data-close aria-label="Close">×</button>
      </div>
    </header>
    <div class="panel-body">
      <input class="panel-title" data-field="title" aria-label="Task title" maxlength="300">
      <div class="panel-fields">
        <label class="field"><span>Status</span>
          <select data-field="status">${options(TASK_STATUSES, task.status)}</select></label>
        <label class="field"><span>Assignee</span>
          <select data-field="assignee_id"></select></label>
        <label class="field"><span>Due date</span>
          <input type="date" data-field="due_date"></label>
      </div>
      <label class="field"><span>Description</span>
        <textarea data-field="description" rows="5" placeholder="Add more detail"></textarea></label>
      <section class="time-box">
        <h3>Time</h3>
        <div class="time-box-row">
          <span data-hours class="muted">Loading hours…</span>
          <span class="spacer"></span>
          <button class="btn btn-small" type="button" data-start-timer>▶ Start timer</button>
          <button class="btn btn-small" type="button" data-add-time>Add time</button>
        </div>
      </section>
      <section class="subtasks">
        <h3>Subtasks <span class="muted" data-subcount></span></h3>
        <ul class="subtask-list" data-subtasks></ul>
        <form class="subtask-add" data-add-subtask>
          <input placeholder="Add a subtask and press Enter" aria-label="New subtask" maxlength="300">
        </form>
      </section>
      <section class="attachments" data-attachments></section>
      <section class="comments" data-comments></section>
    </div>`;

  fillFields();
  renderSubtasks();
  if (current.highlight) {
    const row = panel.querySelector(`[data-subtasks] li[data-id="${CSS.escape(current.highlight)}"]`);
    if (row) {
      row.classList.add('is-highlight');
      setTimeout(() => row.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
    }
  }

  panel.querySelector('[data-close]').addEventListener('click', closeTaskPanel);
  panel.querySelector('[data-delete]').addEventListener('click', removeTask);
  panel.querySelectorAll('[data-field]').forEach(input => input.addEventListener('change', () => saveField(input)));
  panel.querySelector('[data-add-subtask]').addEventListener('submit', addSubtask);
  panel.querySelector('[data-start-timer]').addEventListener('click', () =>
    startTimer({ campaign_id: task.campaign_id, task_id: task.id }));
  panel.querySelector('[data-add-time]').addEventListener('click', () =>
    openTimeEntryForm({ defaults: { campaign_id: task.campaign_id, task_id: task.id } })
      .catch(error => toast(errorMessage(error), 'error')));

  const list = panel.querySelector('[data-subtasks]');
  list.addEventListener('change', event => saveSubtaskField(event.target));
  list.addEventListener('click', event => {
    const id = event.target.closest('li')?.dataset.id;
    if (event.target.closest('[data-remove]')) removeSubtask(id);
    if (event.target.closest('[data-sub-timer]')) startTimer({ campaign_id: task.campaign_id, task_id: id });
  });
  mountAttachments(panel.querySelector('[data-attachments]'), task);
  mountComments(panel.querySelector('[data-comments]'), task);
  panel.querySelector('[data-close]').focus();
}

// Put the task's values into the fields, skipping the one being edited
function fillFields() {
  const { panel, task } = current;
  panel.querySelectorAll('[data-field]').forEach(input => {
    if (input === document.activeElement) return;
    if (input.dataset.field === 'assignee_id') input.innerHTML = assigneeOptions(task.assignee_id);
    input.value = task[input.dataset.field] ?? '';
  });
}

function renderSubtasks() {
  const { panel, subtasks } = current;
  const list = panel.querySelector('[data-subtasks]');
  const done = subtasks.filter(s => s.status === 'done').length;
  panel.querySelector('[data-subcount]').textContent = subtasks.length ? `${done}/${subtasks.length}` : '';

  list.innerHTML = subtasks.map(s => `
    <li class="subtask ${s.status === 'done' ? 'is-done' : ''}" data-id="${esc(s.id)}">
      <input type="checkbox" data-sub="status" ${s.status === 'done' ? 'checked' : ''} aria-label="Done">
      <input class="subtask-title" data-sub="title" value="${esc(s.title)}" aria-label="Subtask title" maxlength="300">
      <select class="subtask-assignee" data-sub="assignee_id" aria-label="Subtask assignee">${assigneeOptions(s.assignee_id)}</select>
      <input class="subtask-due" type="date" data-sub="due_date" value="${esc(s.due_date || '')}" aria-label="Subtask due date">
      <button class="icon-btn subtask-timer" type="button" data-sub-timer aria-label="Start timer on this subtask" title="Start timer">▶</button>
      <button class="icon-btn" type="button" data-remove aria-label="Remove subtask">×</button>
    </li>`).join('');
}

// Hours on the task and its subtasks. Tasks with hours can't be deleted.
async function loadHours() {
  const mine = current;
  if (!mine?.task) return;
  let hours;
  try {
    hours = await loadTasksHours([mine.task.id, ...mine.subtasks.map(s => s.id)]);
  } catch {
    return;
  }
  if (current !== mine) return;
  mine.hours = hours;
  mine.panel.querySelector('[data-hours]').textContent = hours
    ? `${fmtHours(hours)} logged${mine.subtasks.length ? ' (including subtasks)' : ''}`
    : 'No hours logged yet';
  const remove = mine.panel.querySelector('[data-delete]');
  remove.disabled = hours > 0;
  remove.title = hours > 0 ? "This task has hours logged, so it can't be deleted. Set it to Done instead." : '';
}

// Someone (maybe you, in another view) changed a task: reload what's shown
async function refresh() {
  if (!current?.task) return;
  const mine = current;
  let data;
  try {
    data = await loadTask(mine.taskId);
  } catch {
    return;
  }
  if (current !== mine) return;
  if (!data) {
    closeTaskPanel();
    toast('This task was deleted.');
    return;
  }
  data.task.campaign = mine.task.campaign;
  Object.assign(current, data);
  fillFields();
  // Wait to redraw subtasks while one is being edited
  if (!mine.panel.querySelector('[data-subtasks]').contains(document.activeElement)) renderSubtasks();
  loadHours();
}

async function saveField(input) {
  const field = input.dataset.field;
  let value = input.value;
  if (field === 'title') {
    value = value.trim();
    if (!value) {
      input.value = current.task.title;
      return;
    }
  } else if (field === 'description') {
    value = value.trim() || null;
  } else if (field === 'assignee_id' || field === 'due_date') {
    value = value || null;
  }
  if (value === current.task[field]) return;

  const mine = current;
  try {
    const saved = await updateTask(mine.task.id, { [field]: value });
    Object.assign(mine.task, saved, { campaign: mine.task.campaign });
  } catch (error) {
    toast(errorMessage(error), 'error');
    input.value = mine.task[field] ?? '';
  }
}

async function saveSubtaskField(input) {
  const field = input.dataset.sub;
  if (!field) return;
  const id = input.closest('li').dataset.id;
  const subtask = current.subtasks.find(s => s.id === id);
  let value;
  if (field === 'status') value = input.checked ? 'done' : 'todo';
  else if (field === 'title') {
    value = input.value.trim();
    if (!value) {
      input.value = subtask.title;
      return;
    }
  } else value = input.value || null;

  try {
    Object.assign(subtask, await updateTask(id, { [field]: value }));
    if (field === 'status') renderSubtasks();
  } catch (error) {
    toast(errorMessage(error), 'error');
    renderSubtasks();
  }
}

async function addSubtask(event) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  const mine = current;
  const last = mine.subtasks[mine.subtasks.length - 1];
  input.value = '';
  try {
    const subtask = await createTask({
      campaign_id: mine.task.campaign_id,
      parent_id: mine.task.id,
      title,
      position: last ? last.position + 1000 : 1000,
    });
    if (current !== mine) return;
    mine.subtasks.push(subtask);
    renderSubtasks();
  } catch (error) {
    input.value = title;
    toast(errorMessage(error), 'error');
  }
}

async function removeSubtask(id) {
  const mine = current;
  try {
    await deleteTask(id);
    mine.subtasks = mine.subtasks.filter(s => s.id !== id);
    if (current === mine) renderSubtasks();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

async function removeTask() {
  const { task, subtasks } = current;
  const ok = await confirmDialog({
    title: 'Delete task?',
    message: `“${task.title}”${subtasks.length ? ` and its ${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}` : ''} will be deleted for everyone. This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteTask(task.id);
    closeTaskPanel();
    toast('Task deleted');
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
