import { supabase } from './supabase.js';
import { isoDate, todayIso } from './tasks.js';
import { addDays } from './time.js';

// Months are 'YYYY-MM'; dates are 'YYYY-MM-DD'

export const currentMonth = () => todayIso().slice(0, 7);

export function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthFirst(month) {
  return `${month}-01`;
}

export function monthLast(month) {
  const [y, m] = month.split('-').map(Number);
  return isoDate(new Date(y, m, 0));
}

export function monthName(month, style = 'long') {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: style, year: 'numeric' });
}

// A month, or the calendar quarter it falls in
export function periodFor(month, mode) {
  if (mode === 'quarter') {
    const [y, m] = month.split('-').map(Number);
    const q = Math.floor((m - 1) / 3);
    const months = [0, 1, 2].map(i => `${y}-${String(q * 3 + i + 1).padStart(2, '0')}`);
    return {
      months,
      from: monthFirst(months[0]),
      to: monthLast(months[2]),
      label: `Q${q + 1} ${y} (${monthName(months[0], 'short').split(' ')[0]}–${monthName(months[2], 'short')})`,
    };
  }
  return { months: [month], from: monthFirst(month), to: monthLast(month), label: monthName(month) };
}

function datesBetween(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

const isWeekday = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  return weekday !== 0 && weekday !== 6;
};

// Hours someone can work between two dates: weekdays, minus their calendar's
// bank holidays, minus their time off, times their hours per day
export function availability(person, from, to, holidays, timeOff) {
  const weekdays = datesBetween(from, to).filter(isWeekday);
  const holidayDates = new Set(holidays.filter(h => h.calendar === person.holiday_calendar).map(h => h.date));
  const offRanges = timeOff.filter(t => t.person_id === person.id);
  const isOff = day => offRanges.some(t => day >= t.start_date && day <= t.end_date);

  let holidayDays = 0;
  let offDays = 0;
  let workDays = 0;
  weekdays.forEach(day => {
    if (holidayDates.has(day)) holidayDays += 1;
    else if (isOff(day)) offDays += 1;
    else workDays += 1;
  });
  return {
    weekdays: weekdays.length,
    holidayDays,
    offDays,
    workDays,
    hours: workDays * Number(person.hours_per_day),
  };
}

// Weekdays a time-off range actually takes (not counting bank holidays)
export function timeOffWorkdays(range, holidays, calendar) {
  const holidayDates = new Set(holidays.filter(h => h.calendar === calendar).map(h => h.date));
  return datesBetween(range.start_date, range.end_date).filter(d => isWeekday(d) && !holidayDates.has(d)).length;
}

// Data ----------------------------------------------------------------------

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// { 'YYYY-MM': { education_hours, planning_center_hours } }
export async function loadBudgets(fromMonth, toMonth) {
  const data = await rows(supabase.from('monthly_budgets').select('*')
    .gte('month', monthFirst(fromMonth)).lte('month', monthFirst(toMonth)));
  return Object.fromEntries(data.map(b => [b.month.slice(0, 7), b]));
}

export async function saveBudget(month, values) {
  const { error } = await supabase.from('monthly_budgets')
    .upsert({ month: monthFirst(month), ...values }, { onConflict: 'month' });
  if (error) throw error;
}

export function loadHolidays(from, to) {
  return rows(supabase.from('bank_holidays').select('*').gte('date', from).lte('date', to).order('date'));
}

// Time off overlapping the dates (all of it if no dates are given)
export function loadTimeOff({ from = null, to = null, personId = null } = {}) {
  let query = supabase.from('time_off').select('*').order('start_date');
  if (from) query = query.gte('end_date', from);
  if (to) query = query.lte('start_date', to);
  if (personId) query = query.eq('person_id', personId);
  return rows(query);
}

export async function createTimeOff(values) {
  const { error } = await supabase.from('time_off').insert(values);
  if (error) throw error;
}

export async function deleteTimeOff(id) {
  const { error } = await supabase.from('time_off').delete().eq('id', id);
  if (error) throw error;
}
