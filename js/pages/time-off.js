import { state, isAdmin } from '../state.js';
import { todayIso } from '../tasks.js';
import { addDays } from '../time.js';
import { loadTimeOff, loadHolidays, createTimeOff, deleteTimeOff, timeOffWorkdays } from '../capacity.js';
import { esc, options, avatar, fmtDate, formDialog, confirmDialog, toast, errorMessage } from '../ui.js';

const REASONS = { Holiday: 'Holiday', Absence: 'Absence' };

// Add days off. The Admin can pick anyone; others add their own.
export function openTimeOffForm({ personId = state.me.id, onSaved } = {}) {
  const people = state.people.filter(p => p.active && p.role !== 'director');
  formDialog({
    title: 'Add time off',
    body: `
      ${isAdmin() ? `
        <label class="field"><span>Person</span>
          <select name="person_id">${options(Object.fromEntries(people.map(p => [p.id, p.name])), personId)}</select></label>` : ''}
      <div class="field-row">
        <label class="field"><span>From</span><input type="date" name="start_date" required value="${todayIso()}"></label>
        <label class="field"><span>To (same day for one day)</span><input type="date" name="end_date" required value="${todayIso()}"></label>
      </div>
      <label class="field"><span>Reason</span><select name="reason">${options(REASONS, 'Holiday')}</select></label>
      <p class="muted small">Full days only. Weekends and bank holidays inside the dates aren't counted.</p>`,
    submitLabel: 'Add time off',
    onSubmit: async form => {
      const f = Object.fromEntries(new FormData(form));
      if (!f.start_date || !f.end_date) return 'Choose the dates.';
      if (f.end_date < f.start_date) return 'The last day must be on or after the first day.';
      await createTimeOff({
        person_id: f.person_id || personId,
        start_date: f.start_date,
        end_date: f.end_date,
        reason: f.reason,
      });
      toast('Time off added');
      onSaved?.();
    },
  });
}

// List of time off from 60 days ago onwards, for one person or everyone
export async function renderTimeOffList(container, { personId = null } = {}) {
  container.innerHTML = '<p class="muted">Loading time off…</p>';
  const from = addDays(todayIso(), -60);
  let ranges;
  let holidays;
  try {
    [ranges, holidays] = await Promise.all([
      loadTimeOff({ from, personId }),
      loadHolidays(from, addDays(todayIso(), 800)),
    ]);
  } catch (error) {
    container.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  if (!ranges.length) {
    container.innerHTML = `<p class="muted">No time off ${personId ? 'added' : 'for anyone'} from ${esc(fmtDate(from))} onwards.</p>`;
    return;
  }

  const canDelete = range => isAdmin() || range.person_id === state.me.id;
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>${personId ? '' : '<th>Person</th>'}<th>Dates</th><th class="num">Working days</th><th>Reason</th><th></th></tr>
        </thead>
        <tbody>
          ${ranges.map(range => {
            const person = state.people.find(p => p.id === range.person_id);
            const days = timeOffWorkdays(range, holidays, person?.holiday_calendar || 'Madrid');
            const past = range.end_date < todayIso();
            return `
              <tr data-id="${esc(range.id)}" class="${past ? 'is-past' : ''}">
                ${personId ? '' : `<td><span class="person">${avatar(person, 24)}${esc(person?.name || 'Unknown')}</span></td>`}
                <td class="nowrap">${esc(fmtDate(range.start_date))}${range.end_date !== range.start_date ? ` – ${esc(fmtDate(range.end_date))}` : ''}</td>
                <td class="num">${days}</td>
                <td>${esc(range.reason)}</td>
                <td class="row-actions">${canDelete(range)
                  ? '<button class="btn btn-small btn-danger-outline" type="button" data-delete>Delete</button>' : ''}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  container.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    const range = ranges.find(r => r.id === button.closest('tr').dataset.id);
    const ok = await confirmDialog({
      title: 'Delete time off?',
      message: `${fmtDate(range.start_date)}${range.end_date !== range.start_date ? ` – ${fmtDate(range.end_date)}` : ''} (${range.reason}) will be removed.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTimeOff(range.id);
      toast('Time off deleted');
      renderTimeOffList(container, { personId });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }));
}
