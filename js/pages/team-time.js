import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { todayIso } from '../tasks.js';
import { addDays, weekStart } from '../time.js';
import { esc, avatar, fmtHours, errorMessage } from '../ui.js';

// Team time (Admin): everyone's hours side by side, by day for a week or by
// week for a month, with each person's split by business unit.
const view = { mode: 'week', month: todayIso().slice(0, 7) };

function parse(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const short = iso => parse(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Columns: the days of the week, or the (Monday-based) weeks of the month
function columnsFor(week) {
  if (view.mode === 'week') {
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(week, i);
      return {
        from: day,
        to: day,
        head: `${parse(day).toLocaleDateString('en-GB', { weekday: 'short' })}<br><span class="muted">${esc(short(day))}</span>`,
      };
    });
  }
  const { from, to } = monthBounds(view.month);
  const columns = [];
  for (let start = weekStart(from); start <= to; start = addDays(start, 7)) {
    const colFrom = start < from ? from : start;
    const colTo = addDays(start, 6) > to ? to : addDays(start, 6);
    columns.push({ from: colFrom, to: colTo, head: `${esc(short(colFrom))}<br><span class="muted">– ${esc(short(colTo))}</span>` });
  }
  return columns;
}

export async function renderTeamTime(container, { week, onPickPerson }) {
  const columns = columnsFor(week);
  const from = columns[0].from;
  const to = columns[columns.length - 1].to;
  const period = view.mode === 'week'
    ? `${short(from)} – ${short(to)}`
    : parse(from).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  container.innerHTML = `
    <div class="team-time-head">
      <h2>Team time</h2>
      <div class="view-switch" role="group" aria-label="Period">
        <button type="button" data-mode="week" aria-pressed="${view.mode === 'week'}">Week</button>
        <button type="button" data-mode="month" aria-pressed="${view.mode === 'month'}">Month</button>
      </div>
      ${view.mode === 'month' ? `
        <div class="week-nav">
          <button class="btn" type="button" data-month="-1" aria-label="Previous month">‹</button>
          <button class="btn" type="button" data-month="1" aria-label="Next month">›</button>
        </div>` : ''}
      <strong>${esc(period)}</strong>
    </div>
    <div data-team-grid><p class="muted">Loading…</p></div>`;

  const rerender = () => renderTeamTime(container, { week, onPickPerson });
  container.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    view.mode = button.dataset.mode;
    if (view.mode === 'month') view.month = week.slice(0, 7);
    rerender();
  }));
  container.querySelectorAll('[data-month]').forEach(button => button.addEventListener('click', () => {
    view.month = shiftMonth(view.month, Number(button.dataset.month));
    rerender();
  }));

  const { data: entries, error } = await supabase
    .from('time_entries')
    .select('person_id, entry_date, minutes, education_hours, planning_center_hours, internal_hours')
    .gte('entry_date', from).lte('entry_date', to);
  const grid = container.querySelector('[data-team-grid]');
  if (!grid) return;
  if (error) {
    grid.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }

  // Everyone who counts in capacity, plus anyone else who logged time
  const loggedIds = new Set(entries.map(e => e.person_id));
  const people = state.people
    .filter(p => loggedIds.has(p.id) || (p.active && p.role !== 'director' && p.counts_in_capacity))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hoursIn = (list, col) => list
    .filter(e => e.entry_date >= col.from && e.entry_date <= col.to)
    .reduce((sum, e) => sum + e.minutes, 0) / 60;
  const sum = (list, field) => list.reduce((total, e) => total + Number(e[field]), 0);
  // Hide empty weekend columns in week view
  const shown = columns.filter((col, i) => view.mode === 'month' || i < 5 || hoursIn(entries, col) > 0);

  grid.innerHTML = `
    <div class="table-wrap">
      <table class="table time-grid team-grid">
        <thead>
          <tr>
            <th>Person</th>
            ${shown.map(col => `<th class="num">${col.head}</th>`).join('')}
            <th class="num">Total</th>
            <th class="num unit-col">Education</th>
            <th class="num unit-col">Planning Center</th>
            <th class="num unit-col">Internal</th>
          </tr>
        </thead>
        <tbody>
          ${people.map(person => {
            const mine = entries.filter(e => e.person_id === person.id);
            return `
              <tr class="clickable" data-person="${esc(person.id)}" title="Open ${esc(person.name)}'s week">
                <td><span class="person">${avatar(person, 24)}${esc(person.name)}</span></td>
                ${shown.map(col => {
                  const hours = hoursIn(mine, col);
                  return `<td class="num">${hours ? fmtHours(hours) : '<span class="muted">–</span>'}</td>`;
                }).join('')}
                <td class="num total"><strong>${fmtHours(sum(mine, 'minutes') / 60)}</strong></td>
                <td class="num unit-col">${fmtHours(sum(mine, 'education_hours'))}</td>
                <td class="num unit-col">${fmtHours(sum(mine, 'planning_center_hours'))}</td>
                <td class="num unit-col">${fmtHours(sum(mine, 'internal_hours'))}</td>
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th>Team total</th>
            ${shown.map(col => `<th class="num">${fmtHours(hoursIn(entries, col))}</th>`).join('')}
            <th class="num week-total">${fmtHours(sum(entries, 'minutes') / 60)}</th>
            <th class="num unit-col">${fmtHours(sum(entries, 'education_hours'))}</th>
            <th class="num unit-col">${fmtHours(sum(entries, 'planning_center_hours'))}</th>
            <th class="num unit-col">${fmtHours(sum(entries, 'internal_hours'))}</th>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="muted small">Shared hours are already split into Education and Planning Center. Click a person to open their week above.</p>`;

  grid.querySelectorAll('tr[data-person]').forEach(row =>
    row.addEventListener('click', () => onPickPerson(row.dataset.person)));
}
