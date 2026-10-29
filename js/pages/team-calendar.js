import { supabase } from '../supabase.js';
import { state, isAdmin, canEditWork } from '../state.js';
import { todayIso } from '../tasks.js';
import { addDays } from '../time.js';
import { shiftMonth, monthFirst, monthLast, monthName, currentMonth, loadHolidays, loadTimeOff, deleteTimeOff } from '../capacity.js';
import { esc, avatar, fmtDate, toast, errorMessage, confirmDialog, formDialog } from '../ui.js';
import { openTimeOffForm } from './time-off.js';

// Team calendar: one row per person, one column per day of the month, with
// time off, each person's own bank holidays and their non-working days.
// Click a free working day to add time off; click a day off to remove it.

const view = { month: currentMonth() };

const isoWeekday = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay() || 7; };

// You change your own time off; the Admin changes anyone's
const canChange = personId => isAdmin() || (personId === state.me.id && canEditWork());

// manageHolidays (Admin, in Settings): adds a row per holiday calendar where
// bank holidays are added, renamed and deleted
export async function renderTeamCalendar(container, { onChanged, manageHolidays = false } = {}) {
  const from = monthFirst(view.month);
  const to = monthLast(view.month);
  container.innerHTML = `
    <div class="cal-head">
      <div class="week-nav">
        <button class="btn btn-small" type="button" data-shift="-1" aria-label="Previous month">‹</button>
        <button class="btn btn-small" type="button" data-shift="0">This month</button>
        <button class="btn btn-small" type="button" data-shift="1" aria-label="Next month">›</button>
        <strong>${esc(monthName(view.month))}</strong>
      </div>
      <div class="cal-legend" aria-hidden="true">
        <span><span class="cal-key cal-off"></span>Time off</span>
        <span><span class="cal-key cal-holiday"></span>Bank holiday</span>
        <span><span class="cal-key cal-nonwork"></span>Not working</span>
      </div>
    </div>
    <div data-cal><p class="muted">Loading calendar…</p></div>`;

  const redraw = () => renderTeamCalendar(container, { onChanged, manageHolidays });
  container.querySelectorAll('[data-shift]').forEach(button => button.addEventListener('click', () => {
    const shift = Number(button.dataset.shift);
    view.month = shift ? shiftMonth(view.month, shift) : currentMonth();
    redraw();
  }));

  let holidays;
  let timeOff;
  try {
    [holidays, timeOff] = await Promise.all([loadHolidays(from, to), loadTimeOff({ from, to })]);
  } catch (error) {
    container.querySelector('[data-cal]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const today = todayIso();
  const people = state.people
    .filter(p => p.active && p.role !== 'director')
    .sort((a, b) => (a.id === state.me.id ? -1 : b.id === state.me.id ? 1 : a.name.localeCompare(b.name)));

  const cell = (person, day) => {
    const workingDays = (person.working_days || [1, 2, 3, 4, 5]).map(Number);
    const holiday = holidays.find(h => h.calendar === person.holiday_calendar && h.date === day);
    const off = timeOff.find(t => t.person_id === person.id && day >= t.start_date && day <= t.end_date);
    const working = workingDays.includes(isoWeekday(day));
    const date = fmtDate(day);
    // Holiday or Absence is shown only to the person and the Admin
    const reason = off && (person.id === state.me.id || isAdmin()) ? off.reason : 'Off';
    let kind = 'free';
    let label = `${person.name}, ${date}: working day`;
    if (off) { kind = 'off'; label = `${person.name}, ${date}: ${reason}`; }
    else if (holiday) { kind = 'holiday'; label = `${person.name}, ${date}: ${holiday.name}`; }
    else if (!working) { kind = 'nonwork'; label = `${person.name}, ${date}: not working`; }
    const actionable = canChange(person.id) && (kind === 'off' || kind === 'free');
    const attrs = `class="cal-cell cal-${kind} ${day === today ? 'is-today' : ''}" title="${esc(label)}" aria-label="${esc(label)}"
      data-person="${esc(person.id)}" data-day="${day}" ${off ? `data-off="${esc(off.id)}"` : ''}`;
    return actionable ? `<button type="button" ${attrs}></button>` : `<span ${attrs}></span>`;
  };

  container.querySelector('[data-cal]').innerHTML = `
    <div class="cal-scroll">
      <div class="cal-grid" style="grid-template-columns: minmax(130px, 170px) repeat(${days.length}, minmax(26px, 1fr))">
        <span class="cal-corner"></span>
        ${days.map(day => {
          const wd = isoWeekday(day);
          return `<span class="cal-day ${wd > 5 ? 'is-weekend' : ''} ${day === today ? 'is-today' : ''}">
            <span>${'MTWTFSS'[wd - 1]}</span><strong>${Number(day.slice(8))}</strong></span>`;
        }).join('')}
        ${manageHolidays && isAdmin() ? ['Madrid', 'England'].map(calendar => `
          <span class="cal-person cal-calendar-row">Bank holidays · ${calendar}</span>
          ${days.map(day => {
            const holiday = holidays.find(h => h.calendar === calendar && h.date === day);
            const label = holiday ? `${calendar}, ${fmtDate(day)}: ${holiday.name}` : `${calendar}, ${fmtDate(day)}: add a bank holiday`;
            return `<button type="button" class="cal-cell ${holiday ? 'cal-holiday' : 'cal-free cal-calendar-free'} ${day === today ? 'is-today' : ''}"
              title="${esc(label)}" aria-label="${esc(label)}" data-calendar="${calendar}" data-day="${day}" ${holiday ? `data-holiday="${esc(holiday.id)}"` : ''}></button>`;
          }).join('')}`).join('') : ''}
        ${people.map(person => `
          <span class="cal-person">${avatar(person, 22)}<span>${esc(person.id === state.me.id ? `${person.name} (you)` : person.name)}</span></span>
          ${days.map(day => cell(person, day)).join('')}`).join('')}
      </div>
    </div>
    <p class="muted small table-note">${canEditWork() ? 'Click a free day on your row to add time off, or a day off to remove it.' : ''}
      Bank holidays follow each person's calendar (Madrid or England).</p>`;

  container.querySelectorAll('button[data-calendar]').forEach(button => button.addEventListener('click', () =>
    editHoliday(button.dataset.calendar, button.dataset.day, holidays.find(h => h.id === button.dataset.holiday), () => {
      redraw();
      onChanged?.();
    })));

  container.querySelectorAll('button.cal-cell[data-person]').forEach(button => button.addEventListener('click', async () => {
    const { person: personId, day, off } = button.dataset;
    if (!off) {
      openTimeOffForm({ personId, date: day, onSaved: () => { redraw(); onChanged?.(); } });
      return;
    }
    const range = timeOff.find(t => t.id === off);
    const person = state.people.find(p => p.id === personId);
    const ok = await confirmDialog({
      title: 'Remove this time off?',
      message: `${person.name}: ${fmtDate(range.start_date)}${range.end_date !== range.start_date ? ` – ${fmtDate(range.end_date)}` : ''} will be removed.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTimeOff(range.id);
      toast('Time off removed');
      redraw();
      onChanged?.();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));
}

// Add a bank holiday on a day, or rename / delete an existing one
function editHoliday(calendar, day, holiday, done) {
  const dialog = formDialog({
    title: holiday ? `Bank holiday · ${calendar}` : `Add a bank holiday · ${calendar}`,
    submitLabel: holiday ? 'Save' : 'Add',
    body: `
      <p class="muted">${esc(fmtDate(day))}</p>
      <label class="field"><span>Name</span>
        <input name="name" required maxlength="120" value="${esc(holiday?.name || '')}" placeholder="e.g. Christmas Day"></label>`,
    onSubmit: async form => {
      const name = form.elements.name.value.trim();
      if (!name) return 'Give the day a name.';
      const { error } = holiday
        ? await supabase.from('bank_holidays').update({ name }).eq('id', holiday.id)
        : await supabase.from('bank_holidays').insert({ calendar, date: day, name });
      if (error) return errorMessage(error);
      toast(holiday ? 'Bank holiday renamed' : 'Bank holiday added');
      done();
    },
  });
  if (!holiday) return;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-ghost btn-discard';
  remove.textContent = 'Delete this bank holiday';
  remove.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete bank holiday?',
      message: `${fmtDate(day)} (${holiday.name}) will no longer count as a ${calendar} bank holiday.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('bank_holidays').delete().eq('id', holiday.id);
    if (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    toast('Bank holiday deleted');
    dialog.close();
    done();
  });
  dialog.querySelector('.dialog-footer').prepend(remove);
}
