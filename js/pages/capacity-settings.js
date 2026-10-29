import { supabase } from '../supabase.js';
import { state, loadPeople } from '../state.js';
import {
  loadBudgets, saveBudget, monthName, currentMonth, monthBudget, capacityPeople, loadTeamSettings,
  loadHolidays, loadTimeOff,
} from '../capacity.js';
import { esc, options, fmtDate, fmtHours, toast, errorMessage, confirmDialog, formDialog } from '../ui.js';
import { openTimeOffForm, renderTimeOffList } from './time-off.js';
import { renderTeamCalendar } from './team-calendar.js';

const CALENDARS = { Madrid: 'Madrid', England: 'England' };
// Kept between visits
const view = { section: null, budgetYear: Number(currentMonth().slice(0, 4)), holidayCalendar: 'Madrid', holidayYear: Number(currentMonth().slice(0, 4)) };

const SECTIONS = { rules: 'Team rules', budgets: 'Monthly budgets', holidays: 'Bank holidays', 'time-off': 'Time off' };

// Settings > Capacity (Admin): team-wide rules, budgets, bank holidays and
// everyone's time off. Each person's own capacity is set in Settings > People.
export function renderCapacitySettings(el) {
  view.section ||= 'rules';
  el.innerHTML = `
    <div class="view-switch sub-tabs" role="group" aria-label="Capacity sections">
      ${Object.entries(SECTIONS).map(([key, label]) => `<button type="button" data-section="${key}">${label}</button>`).join('')}
    </div>

    <section data-part="rules">
      <form class="card rules-card" data-rules novalidate>
        <h2>Team rules</h2>
        <p class="muted small">How capacity and budgets are worked out. Each person's hours per day, working days and
          calendar are set in <a href="#/settings/people">Settings → People</a>.</p>
        <div class="rules-grid">
          <label class="rule">
            <span class="rule-label">Productive time</span>
            <span class="rule-input"><input type="number" name="productive_pct" min="0" max="100" step="1" required> %</span>
            <span class="muted small">Share of working hours available for campaign work. The rest covers internal meetings, admin and non-productive time.</span>
          </label>
          <label class="rule">
            <span class="rule-label">Budget split</span>
            <span class="rule-input"><input type="number" name="budget_split_education" min="0" max="100" step="1" required> % Education ·
              <strong data-budget-pc>…</strong> Planning Center</span>
            <span class="muted small">How productive hours divide into each unit's monthly budget.</span>
          </label>
          <label class="rule">
            <span class="rule-label">Shared campaigns split</span>
            <span class="rule-input"><input type="number" name="shared_split_education" min="0" max="100" step="1" required> % Education ·
              <strong data-shared-pc>…</strong> Planning Center</span>
            <span class="muted small">How hours on Shared campaigns are divided. Applies to hours logged from now on.</span>
          </label>
        </div>
        <p class="rules-example" data-standard-month></p>
        <div class="rules-actions"><button class="btn btn-primary" type="submit">Save rules</button></div>
      </form>
    </section>

    <section data-part="budgets" hidden>
      <div class="section-head">
        <h2>Monthly budgets</h2>
        <div class="week-nav" data-budget-nav></div>
      </div>
      <p class="muted small section-intro">Calculated automatically from the team's productive hours each month, so bank holidays
        and time off lower them. Type a number to override a month; clear it to go back to automatic.</p>
      <div data-budgets></div>
    </section>

    <section data-part="holidays" hidden>
      <div class="section-head">
        <h2>Bank holidays</h2>
        <div class="view-switch" role="group" aria-label="Calendar" data-calendar-switch></div>
        <div class="week-nav" data-holiday-nav></div>
        <button class="btn btn-small" type="button" data-add-holiday>Add a day</button>
      </div>
      <div data-holidays></div>
    </section>

    <section data-part="time-off" hidden>
      <section class="card team-calendar" data-calendar></section>
      <div class="section-head">
        <h2>Time off</h2>
        <button class="btn btn-small" type="button" data-add-time-off>Add time off</button>
      </div>
      <div data-time-off></div>
    </section>`;

  const show = key => {
    view.section = key;
    el.querySelectorAll('[data-section]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.section === key)));
    el.querySelectorAll('[data-part]').forEach(part => { part.hidden = part.dataset.part !== key; });
    if (key === 'time-off') drawCalendar();
  };
  const drawCalendar = () => renderTeamCalendar(el.querySelector('[data-calendar]'), {
    onChanged: () => renderTimeOffList(el.querySelector('[data-time-off]')),
  });
  el.querySelectorAll('[data-section]').forEach(b => b.addEventListener('click', () => show(b.dataset.section)));
  show(view.section);

  setUpRules(el);
  drawBudgets(el);
  drawHolidays(el);
  const timeOff = el.querySelector('[data-time-off]');
  renderTimeOffList(timeOff);
  el.querySelector('[data-add-time-off]').addEventListener('click', () =>
    openTimeOffForm({ onSaved: () => { renderTimeOffList(timeOff); drawCalendar(); } }));
  el.querySelector('[data-add-holiday]').addEventListener('click', () => addHoliday(el));
}

// Team rules: the three percentages, saved together after a check ------------

async function setUpRules(el) {
  const form = el.querySelector('[data-rules]');
  let settings;
  try {
    [settings] = await Promise.all([loadTeamSettings(), loadPeople()]);
  } catch (error) {
    form.querySelector('.rules-grid').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const fields = ['productive_pct', 'budget_split_education', 'shared_split_education'];
  fields.forEach(f => { form.elements[f].value = settings[f]; });

  const showExample = () => {
    const v = name => Number(form.elements[name].value);
    const pc = name => (form.elements[name].value !== '' && v(name) >= 0 && v(name) <= 100 ? `${100 - v(name)} %` : '–');
    form.querySelector('[data-budget-pc]').textContent = pc('budget_split_education');
    form.querySelector('[data-shared-pc]').textContent = pc('shared_split_education');
    const hours = standardMonthHours(capacityPeople(state.people)) * v('productive_pct') / 100;
    form.querySelector('[data-standard-month]').innerHTML = `In a standard month with no holidays, that's <strong>${fmtHours(Math.round(hours))}</strong>
      of productive time: <strong>${fmtHours(Math.round(hours * v('budget_split_education') / 100))}</strong> Education and
      <strong>${fmtHours(Math.round(hours * (100 - v('budget_split_education')) / 100))}</strong> Planning Center.`;
  };
  fields.forEach(f => form.elements[f].addEventListener('input', showExample));
  showExample();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(fields.map(f => [f, Number(form.elements[f].value)]));
    if (Object.values(values).some(v => !Number.isInteger(v) || v < 0 || v > 100)) {
      toast('Use whole numbers from 0 to 100.', 'error');
      return;
    }
    const changed = fields.filter(f => values[f] !== Number(settings[f]));
    if (!changed.length) {
      toast('Nothing changed.');
      return;
    }
    const effects = [];
    if (changed.includes('productive_pct') || changed.includes('budget_split_education')) {
      effects.push('every automatic monthly budget, past and future, is recalculated');
    }
    if (changed.includes('shared_split_education')) {
      effects.push(`hours logged on Shared campaigns from now on split ${values.shared_split_education} / ${100 - values.shared_split_education} (past entries keep their split)`);
    }
    const ok = await confirmDialog({
      title: 'Save the team rules?',
      message: `If you save: ${effects.join('; and ')}.`,
      confirmLabel: 'Save rules',
    });
    if (!ok) return;
    const { error } = await supabase.from('team_settings').update(values).eq('id', true);
    if (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    Object.assign(settings, values);
    toast('Team rules saved');
    drawBudgets(el);
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

// A standard month: 52 weeks / 12, no holidays
function standardMonthHours(people) {
  return people.reduce((total, p) =>
    total + Number(p.hours_per_day) * (p.working_days?.length || 5) * 52 / 12, 0);
}

async function drawBudgets(el) {
  const year = view.budgetYear;
  yearNav(el.querySelector('[data-budget-nav]'), year, next => { view.budgetYear = next; drawBudgets(el); });
  const box = el.querySelector('[data-budgets]');
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  let overrides;
  let settings;
  let holidays;
  let timeOff;
  try {
    [overrides, settings, holidays, timeOff] = await Promise.all([
      loadBudgets(months[0], months[11]),
      loadTeamSettings(),
      loadHolidays(`${year}-01-01`, `${year}-12-31`),
      loadTimeOff({ from: `${year}-01-01`, to: `${year}-12-31` }),
    ]);
  } catch (error) {
    box.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const people = capacityPeople(state.people);
  const budgets = Object.fromEntries(months.map(m => [m,
    monthBudget(m, { people, holidays, timeOff, settings, override: overrides[m] })]));
  const round = n => Math.round(n);
  const typed = (m, field) => (overrides[m]?.[field] != null ? Number(overrides[m][field]) : '');
  const total = key => months.reduce((t, m) => t + budgets[m][key], 0);
  const hasOverride = m => typed(m, 'education_hours') !== '' || typed(m, 'planning_center_hours') !== '';

  box.innerHTML = `
    <div class="table-wrap">
      <table class="table budget-table">
        <thead><tr><th>Month</th><th class="num">Productive hours</th><th class="num">Education</th><th class="num">Planning Center</th><th></th></tr></thead>
        <tbody>
          ${months.map((month, i) => `
            <tr data-month="${month}" class="${month === currentMonth() ? 'is-current' : ''}">
              <td>${esc(monthName(month, 'long').split(' ')[0])}</td>
              <td class="num muted">${fmtHours(round(budgets[month].productiveHours))}</td>
              ${['education_hours', 'planning_center_hours'].map(field => {
                const key = field === 'education_hours' ? 'education' : 'planning_center';
                const isAuto = typed(month, field) === '';
                return `<td class="num"><input class="budget-input ${isAuto ? 'is-auto' : ''}" type="number" min="0" step="1" data-field="${field}"
                  value="${typed(month, field)}" placeholder="${round(budgets[month].auto[key])}"
                  title="${isAuto ? 'Automatic. Type a number to override.' : 'Typed by you. Clear it to go back to automatic.'}"
                  aria-label="${key === 'education' ? 'Education' : 'Planning Center'} budget, ${esc(monthName(month))}"></td>`;
              }).join('')}
              <td class="row-actions nowrap">
                ${hasOverride(month) ? '<button class="btn btn-small btn-ghost" type="button" data-reset>Back to automatic</button>' : '<span class="muted small">Automatic</span>'}
                ${i < 11 && hasOverride(month) ? '<button class="btn btn-small btn-ghost" type="button" data-copy>Copy to next months</button>' : ''}
              </td>
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr><th>Year total</th><th class="num">${fmtHours(round(total('productiveHours')))}</th>
            <th class="num">${fmtHours(round(total('education')))}</th><th class="num">${fmtHours(round(total('planning_center')))}</th><th></th></tr>
        </tfoot>
      </table>
    </div>`;

  // Both empty = automatic, so the override row is removed
  const store = async (month, values) => {
    if (values.education_hours == null && values.planning_center_hours == null) {
      const { error } = await supabase.from('monthly_budgets').delete().eq('month', `${month}-01`);
      if (error) throw error;
    } else {
      await saveBudget(month, values);
    }
  };

  box.querySelectorAll('.budget-input').forEach(input => input.addEventListener('change', async () => {
    const row = input.closest('tr');
    const month = row.dataset.month;
    const values = {};
    for (const field of ['education_hours', 'planning_center_hours']) {
      const raw = row.querySelector(`[data-field="${field}"]`).value;
      const number = raw === '' ? null : Number(raw);
      if (number != null && (!Number.isFinite(number) || number < 0)) {
        toast('Budgets must be 0 or more hours.', 'error');
        drawBudgets(el);
        return;
      }
      values[field] = number;
    }
    try {
      await store(month, values);
      toast(`Budget saved for ${monthName(month)}`);
      drawBudgets(el);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));

  box.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', async () => {
    const month = button.closest('tr').dataset.month;
    try {
      await store(month, { education_hours: null, planning_center_hours: null });
      toast(`${monthName(month)} is automatic again`);
      drawBudgets(el);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));

  box.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const month = button.closest('tr').dataset.month;
    const values = {
      education_hours: typed(month, 'education_hours') === '' ? null : typed(month, 'education_hours'),
      planning_center_hours: typed(month, 'planning_center_hours') === '' ? null : typed(month, 'planning_center_hours'),
    };
    const later = months.filter(m => m > month);
    const describe = v => (v == null ? 'automatic' : fmtHours(v));
    const ok = await confirmDialog({
      title: 'Copy to next months?',
      message: `${monthName(later[0])} to ${monthName(later[later.length - 1])} will get Education ${describe(values.education_hours)} and Planning Center ${describe(values.planning_center_hours)}, replacing what's there.`,
      confirmLabel: 'Copy',
    });
    if (!ok) return;
    try {
      for (const m of later) await store(m, values);
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
