import { supabase } from './supabase.js';
import { announce } from './realtime.js';

// Dates are 'YYYY-MM-DD' strings in local time, so they compare as text
export function isoDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return isoDate(date);
}

// A subtask without its own date uses its parent task's date
export function effectiveDue(task, parent) {
  return task.due_date || parent?.due_date || null;
}

export function isOverdue(due, status) {
  return Boolean(due) && status !== 'done' && due < todayIso();
}

// My tasks groups. "This week" is the next 7 days, starting tomorrow.
export const DUE_GROUPS = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  none: 'No date',
};

export function dueGroup(due) {
  if (!due) return 'none';
  const today = todayIso();
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= todayIso(7)) return 'week';
  return 'later';
}

// Board order: a new position between two neighbours (either may be missing)
export function positionBetween(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

export function byPosition(a, b) {
  return a.position - b.position || a.created_at.localeCompare(b.created_at);
}

// % of main tasks done (subtasks don't count), or null when there are none
export function tasksDonePct(tasks) {
  const main = tasks.filter(t => !t.parent_id);
  if (!main.length) return null;
  return Math.round(main.filter(t => t.status === 'done').length / main.length * 100);
}

export function announceTaskChange() {
  announce('tasks-changed');
}

export async function loadCampaignTasks(campaignId) {
  const { data, error } = await supabase.from('tasks').select('*').eq('campaign_id', campaignId);
  if (error) throw error;
  return data;
}

export async function createTask(values) {
  const { data, error } = await supabase.from('tasks').insert(values).select().single();
  if (error) throw error;
  announceTaskChange();
  return data;
}

export async function updateTask(id, values) {
  const { data, error } = await supabase.from('tasks').update(values).eq('id', id).select().single();
  if (error) throw error;
  announceTaskChange();
  return data;
}

export async function deleteTask(id) {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw error;
  announceTaskChange();
}
