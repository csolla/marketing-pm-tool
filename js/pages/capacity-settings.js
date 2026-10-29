import { supabase } from '../supabase.js';
import { state, loadPeople } from '../state.js';
import { loadBudgets, saveBudget, monthName, currentMonth } from '../capacity.js';
import { esc, options, avatar, fmtDate, fmtHours, toast, errorMessage, confirmDialog, formDialog } from '../ui.js';
import { openTimeOffForm, renderTimeOffList } from './time-off.js';

const CALENDARS = { Madrid: 'Madrid', England: 'England' };
// Kept between visits
const view = { budgetYear: Number(currentMonth().slice(0, 4)), holidayCalendar: 'Madrid', holidayYear: Number(currentMonth().slice(0, 4)) };

// Settings > Capacity (Admin)
export function renderCapacitySettings(el) {
  el.innerHTML = `
    <section class="section first">
      <h2>People's capacity</h2>
      <p class="muted small section-intro">Hours each person is available on a working day, whether they count towards team capacity, and which bank holidays apply to them.</p>
      <div data-people></div>
    </section>
    <section class="section">
      <form class="card split-card" data-split novalidate>
        <div>
          <h2>Shared campaigns split</h2>
          <p class="muted small">How hours logged on Shared campaigns divide between the two business units.
            Changes apply to hours logged from now on; past entries keep their split.</p>
        </div>
        <div class="split-inputs">
          <label class="inline-field">Education
            <input type="number" name="education" min="0" max="100" step="1" required aria-label="Education percentage"> %</label>
          <span class="muted">Planning Center <strong data-pc>…</strong></span>
          <button class="btn btn-primary btn-small" type="submit">Save</button>
        </div>
      </form>
    </section>
    <section class="section">
      <div class="section-head">
        <h2>Monthly budgets</h2>
        <div class="week-nav" data-budget-nav></div>
      </div>
      <p class="muted small section-intro">Hours Marketing can give each business unit per month. Changes save as you type.</p>
      <div data-budgets></div>
    </section>
    <section class="section">
      <div class="section-head">
        <h2>Bank holidays</h2>
        <div class="view-switch" role="group" aria-label="Calendar" data-calendar-switch></div>
        <div class="week-nav" data-holiday-nav></div>
        <button class="btn btn-small" type="button" data-add-holiday>Add a day</button>
      </div>
      <div data-holidays></div>
    </section>
    <section class="section">
      <div class="section-head">
        <h2>Time off</h2>
        <button class="btn btn-small" type="button" data-add-time-off>Add time off</button>
      </div>
      <div data-time-off></div>
    </section>`;

  drawPeople(el);
  setUpSplit(el);
  drawBudgets(el);
  drawHolidays(el);
  const timeOff = el.querySelector('[data-time-off]');
  renderTimeOffList(timeOff);
  el.querySelector('[data-add-time-off]').addEventListener('click', () =>
    openTimeOffForm({ onSaved: () => renderTimeOffList(timeOff) }));
  el.querySelector('[data-add-holiday]').addEventListener('click', () => addHoliday(el));
}

// People's capacity -----------------------------------------------------------

async function drawPeople(el) {
  const box = el.querySelector('[data-people]');
  try {
    await loadPeople();
  } catch (error) {
    box.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const people = state.people.filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name));
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Person</th><th>Hours per day</th><th>Counts in capacity</th><th>Holiday calendar</th></tr></thead>
        <tbody>
          ${people.map(p => `
            <tr data-id="${esc(p.id)}">
              <td><span class="person">${avatar(p, 28)}<span>${esc(p.name)}${p.role === 'director' ? ' <span class="muted small">(Director)</span>' : ''}</span></span></td>
              <td><input class="hours-input" type="number" data-field="hours_per_day" min="0" max="24" step="0.5"
                value="${esc(p.hours_per_day)}" aria-label="Hours per day for ${esc(p.name)}"></td>
              <td><input type="checkbox" data-field="counts_in_capacity" ${p.counts_in_capacity ? 'checked' : ''}
                aria-label="${esc(p.name)} counts in capacity"></td>
              <td><select data-field="holiday_calendar" aria-label="Holiday calendar for ${esc(p.name)}">${options(CALENDARS, p.holiday_calendar)}</select></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll('[data-field]').forEach(input => input.addEventListener('change', async () => {
    const person = state.people.find(p => p.id === input.closest('tr').dataset.id);
    const field = input.dataset.field;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (field === 'hours_per_day') {
      value = Number(input.value);
      if (input.value === '' || !Number.isFinite(value) || value < 0 || value > 24) {
        toast('Hours per day must be between 0 and 24.', 'error');
        input.value = person.hours_per_day;
        return;
      }
    }
    const { error } = await supabase.from('people').update({ [field]: value }).eq('id', person.id);
    if (error) {
      toast(errorMessage(error), 'error');
      drawPeople(el);
      return;
    }
    person[field] = value;
    toast(`Saved for ${person.name}`);
  }));
}

// Shared split ------------------------------------------------------------------

async function setUpSplit(el) {
  const form = el.querySelector('[data-split]');
  const input = form.elements.education;
  const showPc = () => {
    const edu = Number(input.value);
    form.querySelector('[data-pc]').textContent = input.value !== '' && edu >= 0 && edu <= 100 ? `${100 - edu} %` : '–';
  };
  input.addEventListener('input', showPc);

  const { data, error } = await supabase.from('team_settings').select('shared_split_education').maybeSingle();
  if (error || !data) {
    form.querySelector('.split-inputs').innerHTML = `<p class="form-error">${esc(errorMessage(error || 'Settings not found'))}</p>`;
    return;
  }
  input.value = data.shared_split_education;
  showPc();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const edu = Number(input.value);
    if (input.value === '' || !Number.isInteger(edu) || edu < 0 || edu > 100) {
      toast('Use a whole number from 0 to 100.', 'error');
      return;
    }
    const { error: saveError } = await supabase.from('team_settings').update({ shared_split_education: edu }).eq('id', true);
    if (saveError) toast(errorMessage(saveError), 'error');
    else toast(`Shared split is now ${edu} / ${100 - edu}`);
  });
}

// Monthly budgets ------------------------------------------------------------------

function yearNav(container, year, onChange) {
  container.innerHTML = `
    <button class="btn btn-small" type="button" data-shift="-1" aria-label="Previous year">‹</button>
    <strong>${year}</strong>
    <button class="btn btn-small" type="button" data-shift="1" aria-label="Next year">›</button>`;
  container.querySelectorAll('[data-shift]').forEach(button =>
    button.addEventListener('click', () => onChange(year + Number(button.dataset.shift))));
}

async function drawBudgets(el) {
  const year = view.budgetYear;
  yearNav(el.querySelector('[data-budget-nav]'), year, next => { view.budgetYear = next; drawBudgets(el); });
  const box = el.querySelector('[data-budgets]');
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  let budgets;
  try {
    budgets = await loadBudgets(months[0], months[11]);
  } catch (error) {
    box.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const value = (month, field) => budgets[month] ? Number(budgets[month][field]) : '';
  const total = field => months.reduce((sum, m) => sum + (Number(budgets[m]?.[field]) || 0), 0);

  box.innerHTML = `
    <div class="table-wrap">
      <table class="table budget-table">
        <thead><tr><th>Month</th><th class="num">Education hours</th><th class="num">Planning Center hours</th><th></th></tr></thead>
        <tbody>
          ${months.map((month, i) => `
            <tr data-month="${month}" class="${month === currentMonth() ? 'is-current' : ''}">
              <td>${esc(monthName(month, 'long').split(' ')[0])}</td>
              <td class="num"><input class="budget-input" type="number" min="0" step="1" data-field="education_hours"
                value="${value(month, 'education_hours')}" aria-label="Education hours, ${esc(monthName(month))}"></td>
              <td class="num"><input class="budget-input" type="number" min="0" step="1" data-field="planning_center_hours"
                value="${value(month, 'planning_center_hours')}" aria-label="Planning Center hours, ${esc(monthName(month))}"></td>
              <td class="row-actions">${i < 11 ? '<button class="btn btn-small btn-ghost" type="button" data-copy>Copy to next months</button>' : ''}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr><th>Year total</th><th class="num">${fmtHours(total('education_hours'))}</th><th class="num">${fmtHours(total('planning_center_hours'))}</th><th></th></tr>
        </tfoot>
      </table>
    </div>`;

  box.querySelectorAll('.budget-input').forEach(input => input.addEventListener('change', async () => {
    const row = input.closest('tr');
    const month = row.dataset.month;
    const values = {};
    for (const field of ['education_hours', 'planning_center_hours']) {
      const raw = row.querySelector(`[data-field="${field}"]`).value;
      const number = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(number) || number < 0) {
        toast('Budgets must be 0 or more hours.', 'error');
        drawBudgets(el);
        return;
      }
      values[field] = number;
    }
    try {
      await saveBudget(month, values);
      toast(`Budget saved for ${monthName(month)}`);
      drawBudgets(el);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));

  box.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const month = button.closest('tr').dataset.month;
    const values = {
      education_hours: Number(budgets[month]?.education_hours) || 0,
      planning_center_hours: Number(budgets[month]?.planning_center_hours) || 0,
    };
    const later = months.filter(m => m > month);
    const ok = await confirmDialog({
      title: 'Copy to next months?',
      message: `${monthName(later[0])} to ${monthName(later[later.length - 1])} will get ${fmtHours(values.education_hours)} Education and ${fmtHours(values.planning_center_hours)} Planning Center, replacing what's there.`,
      confirmLabel: 'Copy',
    });
    if (!ok) return;
    try {
      for (const m of later) await saveBudget(m, values);
      toast(`Copied to ${later.length} month${later.length === 1 ? '' : 's'}`);
      drawBudgets(el);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));
}

// Bank holidays ------------------------------------------------------------------

async function drawHolidays(el) {
  const { holidayCalendar: calendar, holidayYear: year } = view;
  const switcher = el.querySelector('[data-calendar-switch]');
  switcher.innerHTML = Object.keys(CALENDARS).map(c =>
    `<button type="button" data-calendar="${c}" aria-pressed="${c === calendar}">${c}</button>`).join('');
  switcher.querySelectorAll('[data-calendar]').forEach(button => button.addEventListener('click', () => {
    view.holidayCalendar = button.dataset.calendar;
    drawHolidays(el);
  }));
  yearNav(el.querySelector('[data-holiday-nav]'), year, next => { view.holidayYear = next; drawHolidays(el); });

  const box = el.querySelector('[data-holidays]');
  const { data: days, error } = await supabase.from('bank_holidays').select('*')
    .eq('calendar', calendar).gte('date', `${year}-01-01`).lte('date', `${year}-12-31`).order('date');
  if (error) {
    box.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  if (!days.length) {
    box.innerHTML = `<p class="muted">No ${esc(calendar)} bank holidays for ${year} yet. Use “Add a day”.</p>`;
    return;
  }
  const weekday = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short' });
  };
  const isWeekend = iso => ['Sat', 'Sun'].includes(weekday(iso));

  box.innerHTML = `
    <div class="table-wrap">
      <table class="table holiday-table">
        <thead><tr><th>Date</th><th>Name</th><th></th></tr></thead>
        <tbody>
          ${days.map(day => `
            <tr data-id="${esc(day.id)}">
              <td class="nowrap">${esc(weekday(day.date))} ${esc(fmtDate(day.date))}
                ${isWeekend(day.date) ? '<span class="muted small">(weekend: no effect)</span>' : ''}</td>
              <td><input class="holiday-name" data-name value="${esc(day.name)}" maxlength="120" aria-label="Name"></td>
              <td class="row-actions"><button class="btn btn-small btn-danger-outline" type="button" data-delete>Delete</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll('[data-name]').forEach(input => input.addEventListener('change', async () => {
    const name = input.value.trim();
    if (!name) {
      drawHolidays(el);
      return;
    }
    const { error: saveError } = await supabase.from('bank_holidays').update({ name }).eq('id', input.closest('tr').dataset.id);
    if (saveError) toast(errorMessage(saveError), 'error');
    else toast('Saved');
  }));
  box.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    const day = days.find(d => d.id === button.closest('tr').dataset.id);
    const ok = await confirmDialog({
      title: 'Delete bank holiday?',
      message: `${fmtDate(day.date)} (${day.name}) will no longer count as a ${calendar} bank holiday.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const { error: deleteError } = await supabase.from('bank_holidays').delete().eq('id', day.id);
    if (deleteError) toast(errorMessage(deleteError), 'error');
    else drawHolidays(el);
  }));
}

function addHoliday(el) {
  formDialog({
    title: 'Add a bank holiday',
    submitLabel: 'Add',
    body: `
      <label class="field"><span>Calendar</span><select name="calendar">${options(CALENDARS, view.holidayCalendar)}</select></label>
      <label class="field"><span>Date</span><input type="date" name="date" required></label>
      <label class="field"><span>Name</span><input name="name" required maxlength="120" placeholder="e.g. Christmas Day"></label>`,
    onSubmit: async form => {
      const f = Object.fromEntries(new FormData(form));
      if (!f.date) return 'Choose a date.';
      if (!f.name.trim()) return 'Give the day a name.';
      const { error } = await supabase.from('bank_holidays').insert({ calendar: f.calendar, date: f.date, name: f.name.trim() });
      if (error) return /duplicate|unique/i.test(error.message) ? 'That calendar already has a bank holiday on that date.' : errorMessage(error);
      view.holidayCalendar = f.calendar;
      view.holidayYear = Number(f.date.slice(0, 4));
      toast('Bank holiday added');
      drawHolidays(el);
    },
  });
}
