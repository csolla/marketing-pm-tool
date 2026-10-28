import { supabase } from './supabase.js';
import { announce } from './realtime.js';
import { isoDate } from './tasks.js';

// Hours as typed: "1.5", "1,5", "1:30" or "2". Returns minutes, 0 for an
// empty box, or null if it can't be read.
export function parseHours(text) {
  const value = String(text ?? '').trim().replace(',', '.');
  if (!value) return 0;
  const clock = value.match(/^(\d{1,2}):([0-5]\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (/^\d*\.?\d+$/.test(value)) return Math.round(parseFloat(value) * 60);
  return null;
}

// Minutes as the number shown in an hours box: 90 -> "1.5", 25 -> "0.42"
export function hoursText(minutes) {
  return minutes ? String(parseFloat((minutes / 60).toFixed(2))) : '';
}

// Weeks run Monday to Sunday
export function weekStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return isoDate(date);
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

const ENTRY_FIELDS = `*,
  campaign:campaigns(id, name, business_unit),
  task:tasks(id, title, parent_id, parent:tasks!tasks_parent_id_fkey(title))`;

export async function loadEntries(personId, from, to) {
  const { data, error } = await supabase
    .from('time_entries').select(ENTRY_FIELDS)
    .eq('person_id', personId).gte('entry_date', from).lte('entry_date', to)
    .order('entry_date').order('created_at');
  if (error) throw error;
  return data;
}

export async function weekMinutes(personId, start) {
  const { data, error } = await supabase
    .from('time_entries').select('minutes')
    .eq('person_id', personId).gte('entry_date', start).lte('entry_date', addDays(start, 6));
  if (error) throw error;
  return data.reduce((sum, e) => sum + e.minutes, 0);
}

export async function createEntry(values) {
  const { data, error } = await supabase.from('time_entries').insert(values).select().single();
  if (error) throw error;
  announce('time-changed');
  return data;
}

export async function updateEntry(id, values) {
  const { data, error } = await supabase.from('time_entries').update(values).eq('id', id).select().single();
  if (error) throw error;
  announce('time-changed');
  return data;
}

export async function deleteEntry(id) {
  const { error } = await supabase.from('time_entries').delete().eq('id', id);
  if (error) throw error;
  announce('time-changed');
}

// Totals by campaign: { [campaignId]: { hours, education_hours, planning_center_hours } }
export async function loadCampaignHours(campaignId = null) {
  let query = supabase.from('campaign_hours').select('*');
  if (campaignId) query = query.eq('campaign_id', campaignId);
  const { data, error } = await query;
  if (error) throw error;
  return Object.fromEntries(data.map(row => [row.campaign_id, row]));
}

// Hours on these tasks, added together
export async function loadTasksHours(taskIds) {
  if (!taskIds.length) return 0;
  const { data, error } = await supabase.from('task_hours').select('hours').in('task_id', taskIds);
  if (error) throw error;
  return data.reduce((sum, row) => sum + Number(row.hours), 0);
}

// "Campaign › Task" or "Campaign › Parent › Subtask" or "Internal"
export function entryLabel(entry) {
  if (!entry.campaign) return 'Internal';
  if (!entry.task) return entry.campaign.name;
  const parent = entry.task.parent?.title;
  return `${entry.campaign.name} › ${parent ? `${parent} › ` : ''}${entry.task.title}`;
}
