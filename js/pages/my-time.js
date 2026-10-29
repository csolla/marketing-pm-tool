import { supabase } from '../supabase.js';
import { state, canEditWork, isAdmin } from '../state.js';
import { onLiveChange } from '../realtime.js';
import { todayIso } from '../tasks.js';
import {
  parseHours, hoursText, weekStart, addDays, loadEntries, createEntry, updateEntry, deleteEntry, entryLabel,
} from '../time.js';
import { availability, loadHolidays, loadTimeOff } from '../capacity.js';
import { startTimer } from '../timer.js';
import { esc, options, buTag, fmtHours, toast, errorMessage, confirmDialog, BUSINESS_UNITS } from '../ui.js';
import { openTimeEntryForm, pickCampaignTask } from './time-entry-form.js';
import { renderTeamTime } from './team-time.js';
import { openTimeOffForm, renderTimeOffList } from './time-off.js';
import { renderTeamCalendar } from './team-calendar.js';

const WEEKEND_KEY = 'my-time-show-weekend';
// Kept between visits
const view = { tab: 'sheet' };

function savedShowWeekend() {
  try { return localStorage.getItem(WEEKEND_KEY) === '1'; } catch { return false; }
}

const rowKey = e => `${e.campaign_id || 'internal'}|${e.task_id || ''}`;
const sumMinutes = entries => entries.reduce((sum, e) => sum + e.minutes, 0);
const isoWeekday = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay() || 7; };

function dayParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    weekday: date.toLocaleDateString('en-GB', { weekday: 'short' }),
    day: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
  };
}

function weekLabel(start) {
  const end = addDays(start, 6);
  const fmt = (iso, withYear) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB',
      withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  };
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

// You can view anyone's week; you edit your own, the Admin edits anyone's
function canEdit(page) {
  return page.personId === state.me.id ? canEditWork() : isAdmin();
}

const personOf = page => state.people.find(p => p.id === page.personId);

export async function renderMyTime(el) {
  const page = {
    el,
    personId: state.me.id,
    start: weekStart(todayIso()),
    showWeekend: savedShowWeekend(),
    extraRows: [],
    entries: [],
    holidays: [],
    timeOff: [],
    loadId: 0,
  };
  const people = state.people.filter(p => p.role !== 'director' && (p.active || p.id === state.me.id));
  if (view.tab === 'team' && !isAdmin()) view.tab = 'sheet';

  el.innerHTML = `
    <div class="page-header my-tasks-header">
      <div>
        <h1 data-title>My time</h1>
        <div class="week-nav time-week-nav">
          <button class="btn btn-small" type="button" data-week="-7" aria-label="Previous week">‹</button>
          <button class="btn btn-small" type="button" data-week="0">This week</button>
          <button class="btn btn-small" type="button" data-week="7" aria-label="Next week">›</button>
          <strong data-week-label></strong>
        </div>
      </div>
      <div class="week-card" data-week-card>
        <span class="muted small" data-week-card-label>Logged this week</span>
        <strong data-week-hours>…</strong>
        <span class="mini-meter" aria-hidden="true"><span data-week-bar style="width:0%"></span></span>
      </div>
    </div>
    <nav class="tabs" aria-label="My time sections">
      <button type="button" class="tab" data-tab="sheet">Timesheet</button>
      <button type="button" class="tab" data-tab="off">Time off</button>
      ${isAdmin() ? '<button type="button" class="tab" data-tab="team">Team time</button>' : ''}
    </nav>

    <div data-panel="sheet">
      <div class="time-controls">
        <label class="inline-field">Person
          <select data-person>${options(Object.fromEntries(people.map(p => [p.id, p.name])), page.personId)}</select>
        </label>
        <label class="toggle"><input type="checkbox" data-weekend ${page.showWeekend ? 'checked' : ''}> Show weekend</label>
        <span class="spacer"></span>
        <div class="actions" data-actions></div>
      </div>
      <div class="suggestions" data-suggestions></div>
      <div data-grid><p class="muted">Loading…</p></div>
      <section class="section">
        <h2>Entries this week</h2>
        <div data-entries></div>
      </section>
    </div>

    <div data-panel="off" hidden>
      <section class="card team-calendar" data-calendar></section>
      <div class="section-head">
        <h2 data-time-off-title>My time off</h2>
        <span data-time-off-action></span>
      </div>
      <div data-time-off></div>
    </div>

    ${isAdmin() ? '<div data-panel="team" hidden><section class="team-time" data-team></section></div>' : ''}`;

  el.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => showTab(page, button.dataset.tab)));
  el.querySelectorAll('[data-week]').forEach(button => button.addEventListener('click', () => {
    const shift = Number(button.dataset.week);
    page.start = shift ? addDays(page.start, shift) : weekStart(todayIso());
    page.extraRows = [];
    load(page);
  }));
  el.querySelector('[data-person]').addEventListener('change', event => showPerson(page, event.target.value));
  el.querySelector('[data-weekend]').addEventListener('change', event => {
    page.showWeekend = event.target.checked;
    try { localStorage.setItem(WEEKEND_KEY, page.showWeekend ? '1' : '0'); } catch { /* not saved; fine */ }
    draw(page);
  });

  showTab(page, view.tab);
  await load(page);
  onLiveChange(el, 'time-changed', () => load(page));
}

function showTab(page, tab) {
  view.tab = tab;
  page.el.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
    button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  });
  page.el.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
  if (tab === 'team') drawTeam(page);
  if (tab === 'off') drawCalendar(page);
}

// Who's off when, for the whole team; changes refresh the list and the week
function drawCalendar(page) {
  renderTeamCalendar(page.el.querySelector('[data-calendar]'), {
    onChanged: () => {
      renderTimeOffList(page.el.querySelector('[data-time-off]'), { personId: page.personId });
      load(page);
    },
  });
}

function showPerson(page, personId) {
  page.personId = personId;
  page.extraRows = [];
  page.el.querySelector('[data-person]').value = personId;
  load(page);
}

function drawTeam(page) {
  const team = page.el.querySelector('[data-team]');
  if (!team) return;
  renderTeamTime(team, {
    week: page.start,
    onPickPerson: id => {
      showTab(page, 'sheet');
      showPerson(page, id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });
}

async function load(page) {
  const loadId = ++page.loadId;
  const end = addDays(page.start, 6);
  page.el.querySelector('[data-week-label]').textContent = weekLabel(page.start);
  try {
    const [entries, holidays, timeOff] = await Promise.all([
      loadEntries(page.personId, page.start, end),
      loadHolidays(page.start, end),
      loadTimeOff({ from: page.start, to: end, personId: page.personId }),
    ]);
    if (loadId !== page.loadId) return;
    Object.assign(page, { entries, holidays, timeOff });
    draw(page);
    if (page.timeOffFor !== page.personId) {
      page.timeOffFor = page.personId;
      drawTimeOff(page);
    }
    if (view.tab === 'team') drawTeam(page);
    drawSuggestions(page);
  } catch (error) {
    page.el.querySelector('[data-grid]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
  }
}

// What each day is for this person: a working day, a bank holiday, a day off
// or not one of their working days
function dayInfo(page, day) {
  const person = personOf(page);
  const workingDays = (person?.working_days || [1, 2, 3, 4, 5]).map(Number);
  const holiday = page.holidays.find(h => h.calendar === person?.holiday_calendar && h.date === day);
  if (holiday) return { kind: 'holiday', label: 'Bank holiday', title: holiday.name, expected: 0 };
  if (!workingDays.includes(isoWeekday(day))) return { kind: 'off', label: isoWeekday(day) > 5 ? '' : 'Not working', expected: 0 };
  if (page.timeOff.some(t => day >= t.start_date && day <= t.end_date)) return { kind: 'leave', label: 'Day off', expected: 0 };
  return { kind: 'work', label: '', expected: Number(person?.hours_per_day || 0) * 60 };
}

function drawHeader(page) {
  const { el } = page;
  const person = personOf(page);
  const own = page.personId === state.me.id;
  el.querySelector('[data-title]').textContent = own ? 'My time' : `Time: ${person?.name || ''}`;
  el.querySelector('[data-time-off-title]').textContent = own ? 'My time off' : `Time off: ${person?.name || ''}`;

  // Logged against what this person is expected to work this week
  const logged = sumMinutes(page.entries) / 60;
  const expected = person ? availability(person, page.start, addDays(page.start, 6), page.holidays, page.timeOff).hours : 0;
  const thisWeek = page.start === weekStart(todayIso());
  el.querySelector('[data-week-card-label]').textContent = thisWeek ? 'Logged this week' : 'Logged that week';
  el.querySelector('[data-week-hours]').textContent = expected ? `${fmtHours(logged)} of ${fmtHours(expected)}` : fmtHours(logged);
  el.querySelector('[data-week-bar]').style.width = `${expected ? Math.min(100, logged / expected * 100) : 0}%`;

  const actions = el.querySelector('[data-actions]');
  actions.innerHTML = canEdit(page) ? `
    <button class="btn" type="button" data-copy-rows title="Add last week's rows (not the hours)">Copy last week's rows</button>
    <button class="btn" type="button" data-add-row>Add row</button>
    ${own ? '<button class="btn" type="button" data-start>Start timer</button>' : ''}
    <button class="btn btn-primary" type="button" data-add>Add time</button>` : '';
  actions.querySelector('[data-copy-rows]')?.addEventListener('click', () => copyLastWeek(page));
  actions.querySelector('[data-add-row]')?.addEventListener('click', () => pickCampaignTask({
    onPicked: picked => addRow(page, {
      campaign_id: picked.campaign_id,
      task_id: picked.task_id,
      campaign: picked.campaign,
      task: picked.task_id ? { title: picked.taskTitle } : null,
    }),
  }));
  actions.querySelector('[data-start]')?.addEventListener('click', () => startTimer());
  actions.querySelector('[data-add]')?.addEventListener('click', () =>
    openTimeEntryForm({ personId: page.personId, defaults: { entry_date: defaultDate(page) } })
      .catch(error => toast(errorMessage(error), 'error')));
}

function addRow(page, row) {
  if (!buildRows(page).some(r => r.key === rowKey(row))) page.extraRows.push(row);
  draw(page);
  drawSuggestions(page);
}

// Last week's rows (campaign + task), without their hours
async function copyLastWeek(page) {
  try {
    const previous = await loadEntries(page.personId, addDays(page.start, -7), addDays(page.start, -1));
    const existing = new Set(buildRows(page).map(r => r.key));
    const added = new Map();
    previous.forEach(e => {
      const key = rowKey(e);
      if (!existing.has(key) && !added.has(key) && (!e.campaign_id || e.task_id)) added.set(key, e);
    });
    if (!added.size) {
      toast(previous.length ? 'All of last week\'s rows are already here.' : 'Nothing was logged last week.');
      return;
    }
    added.forEach(e => page.extraRows.push({ campaign_id: e.campaign_id, task_id: e.task_id, campaign: e.campaign, task: e.task }));
    draw(page);
    drawSuggestions(page);
    toast(`Added ${added.size} row${added.size === 1 ? '' : 's'} from last week`);
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// One-click rows for tasks assigned to this person that are in progress or
// due this week and aren't in the grid yet
async function drawSuggestions(page) {
  const box = page.el.querySelector('[data-suggestions]');
  if (!canEdit(page)) {
    box.innerHTML = '';
    return;
  }
  const loadId = page.loadId;
  const { data, error } = await supabase.from('tasks')
    .select('id, title, status, due_date, campaign_id, campaign:campaigns(id, name, business_unit), parent:parent_id(title)')
    .eq('assignee_id', page.personId).neq('status', 'done');
  if (error || loadId !== page.loadId) return;
  const end = addDays(page.start, 6);
  const present = new Set(buildRows(page).map(r => r.key));
  const picks = data
    .filter(t => t.status === 'in_progress' || (t.due_date && t.due_date >= page.start && t.due_date <= end))
    .filter(t => !present.has(`${t.campaign_id}|${t.id}`))
    .slice(0, 6);
  if (!picks.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<span class="muted small">Suggested rows:</span>${picks.map(t => `
    <button type="button" class="suggestion" data-task="${esc(t.id)}" title="Add a row for this task">
      + ${esc(t.title)} <span class="muted">· ${esc(t.campaign?.name || '')}</span>
    </button>`).join('')}`;
  box.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => {
    const t = picks.find(p => p.id === button.dataset.task);
    addRow(page, { campaign_id: t.campaign_id, task_id: t.id, campaign: t.campaign, task: { title: t.title, parent: t.parent } });
  }));
}

// Today if it's in the week shown, otherwise that week's Monday
function defaultDate(page) {
  const today = todayIso();
  return today >= page.start && today <= addDays(page.start, 6) ? today : page.start;
}

// Days off for the person shown: their own (or the Admin) can add and delete
function drawTimeOff(page) {
  const { el } = page;
  const list = el.querySelector('[data-time-off]');
  const action = el.querySelector('[data-time-off-action]');
  action.innerHTML = canEdit(page) ? '<button class="btn btn-small" type="button">Add time off</button>' : '';
  action.querySelector('button')?.addEventListener('click', () =>
    openTimeOffForm({
      personId: page.personId,
      onSaved: () => {
        renderTimeOffList(list, { personId: page.personId });
        load(page);
        if (view.tab === 'off') drawCalendar(page);
      },
    }));
  renderTimeOffList(list, { personId: page.personId });
}

function draw(page) {
  drawHeader(page);
  drawGrid(page);
  drawEntries(page);
}

// Weekly grid ----------------------------------------------------------------

function buildRows(page) {
  const rows = new Map();
  [...page.entries, ...page.extraRows].forEach(e => {
    const key = rowKey(e);
    if (!rows.has(key)) {
      rows.set(key, {
        key, campaign_id: e.campaign_id, task_id: e.task_id, label: entryLabel(e), campaign: e.campaign, task: e.task,
      });
    }
  });
  return [...rows.values()].sort((a, b) =>
    (a.campaign ? 0 : 1) - (b.campaign ? 0 : 1) || a.label.localeCompare(b.label));
}

// Campaign name first, then the task (with its main task for a subtask)
function rowLabel(row) {
  if (!row.campaign) {
    return `<span class="row-campaign">Internal</span><span class="row-task">Meetings, admin, training</span>`;
  }
  const task = row.task
    ? `${row.task.parent?.title ? `${esc(row.task.parent.title)} › ` : ''}${esc(row.task.title)}`
    : '';
  return `
    <span class="row-campaign"><span class="unit-dot unit-dot-${esc(row.campaign.business_unit)}" title="${esc(BUSINESS_UNITS[row.campaign.business_unit])}"></span>${esc(row.campaign.name)}</span>
    ${task ? `<span class="row-task">${task}</span>` : ''}`;
}

function drawGrid(page) {
  const grid = page.el.querySelector('[data-grid]');
  const editable = canEdit(page);
  const allDays = Array.from({ length: 7 }, (_, i) => addDays(page.start, i));
  const weekendUsed = page.entries.some(e => e.entry_date >= allDays[5]);
  const days = page.showWeekend || weekendUsed ? allDays : allDays.slice(0, 5);
  const today = todayIso();
  const rows = buildRows(page);
  page.rows = new Map(rows.map(r => [r.key, r]));

  // Keep focus (and anything half-typed) in the same cell across redraws
  const focused = document.activeElement?.dataset?.cell && grid.contains(document.activeElement)
    ? { cell: document.activeElement.dataset.cell, value: document.activeElement.value, original: document.activeElement.defaultValue }
    : null;

  const cellEntries = (key, day) => page.entries.filter(e => rowKey(e) === key && e.entry_date === day);
  const dayTotal = day => sumMinutes(page.entries.filter(e => e.entry_date === day));
  const info = Object.fromEntries(days.map(day => [day, dayInfo(page, day)]));

  grid.innerHTML = `
    <div class="table-wrap">
      <table class="table time-grid">
        <thead>
          <tr>
            <th>Campaign / task</th>
            ${days.map(day => {
              const { weekday, day: date } = dayParts(day);
              const d = info[day];
              return `<th class="num day-${d.kind} ${day === today ? 'is-today' : ''}" ${d.title ? `title="${esc(d.title)}"` : ''}>
                ${esc(weekday)}<br><span class="muted">${esc(date)}</span>${d.label ? `<span class="day-note">${esc(d.label)}</span>` : ''}</th>`;
            }).join('')}
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row, r) => {
            const locked = row.campaign_id && !row.task_id;
            return `
              <tr>
                <td class="row-label">
                  ${rowLabel(row)}
                  ${locked ? '<span class="no-task-hint">No task: use Edit below to choose one</span>' : ''}
                </td>
                ${days.map((day, d) => {
                  const entries = cellEntries(row.key, day);
                  const minutes = sumMinutes(entries);
                  const multi = entries.length > 1;
                  return `<td class="cell day-${info[day].kind}"><input class="cell-input ${multi ? 'is-multi' : ''}" data-cell="${esc(row.key)}@${day}"
                    data-r="${r}" data-d="${d}" inputmode="decimal" value="${esc(hoursText(minutes))}"
                    aria-label="${esc(row.label)}, ${esc(dayParts(day).weekday)}" ${editable && !locked ? '' : 'disabled'}
                    ${multi ? `title="${entries.length} entries. Typing a new total merges them into one."` : ''}></td>`;
                }).join('')}
                <td class="num total">${fmtHours(sumMinutes(page.entries.filter(e => rowKey(e) === row.key)) / 60)}</td>
              </tr>`;
          }).join('') : `
            <tr><td colspan="${days.length + 2}" class="muted empty-row">
              No time logged this week.${editable ? ' Use “Copy last week\'s rows”, a suggested row above, or “Add row”.' : ''}
            </td></tr>`}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            ${days.map(day => {
              const total = dayTotal(day);
              // A past working day well under the person's usual hours
              const under = info[day].kind === 'work' && day < today && total < info[day].expected * 0.9;
              return `<th class="num ${under ? 'is-under' : ''}" ${under ? `title="Under your usual ${fmtHours(info[day].expected / 60)}"` : ''}>${fmtHours(total / 60)}</th>`;
            }).join('')}
            <th class="num week-total">${fmtHours(sumMinutes(page.entries) / 60)}</th>
          </tr>
        </tfoot>
      </table>
    </div>
    ${editable && rows.length ? '<p class="muted small table-note">Type hours as 1.5 or 1:30. Enter moves down, arrow keys move between cells.</p>' : ''}`;

  grid.querySelectorAll('.cell-input').forEach(input => {
    input.addEventListener('change', () => saveCell(page, input));
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', event => moveInGrid(grid, input, event));
  });

  if (focused) {
    const input = grid.querySelector(`[data-cell="${CSS.escape(focused.cell)}"]`);
    if (input) {
      if (focused.value !== focused.original) input.value = focused.value;
      input.focus();
    }
  }
}

// Spreadsheet-style keys: Enter/Down move down, Up moves up, Left/Right move
// between days (at the start/end of the text). Tab works as usual.
function moveInGrid(grid, input, event) {
  const r = Number(input.dataset.r);
  const d = Number(input.dataset.d);
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length;
  const allSelected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
  let target = null;
  if (event.key === 'Enter' || event.key === 'ArrowDown') target = [r + 1, d];
  else if (event.key === 'ArrowUp') target = [r - 1, d];
  else if (event.key === 'ArrowLeft' && (atStart || allSelected)) target = [r, d - 1];
  else if (event.key === 'ArrowRight' && (atEnd || allSelected)) target = [r, d + 1];
  if (!target) return;
  event.preventDefault();
  const next = grid.querySelector(`.cell-input[data-r="${target[0]}"][data-d="${target[1]}"]:not(:disabled)`);
  if (next) next.focus();
  else if (event.key === 'Enter') input.blur();
}

async function saveCell(page, input) {
  const [key, day] = input.dataset.cell.split('@');
  const row = page.rows.get(key);
  const existing = page.entries.filter(e => rowKey(e) === key && e.entry_date === day);
  const minutes = parseHours(input.value);
  const reset = () => { input.value = hoursText(sumMinutes(existing)); };

  if (minutes === null) {
    toast('Type hours as a number, like 1.5 or 1:30.', 'error');
    return reset();
  }
  if (minutes > 1440) {
    toast('One day can have at most 24 hours in a cell.', 'error');
    return reset();
  }
  try {
    if (!existing.length) {
      if (minutes) {
        await createEntry({
          person_id: page.personId, entry_date: day, minutes, campaign_id: row.campaign_id, task_id: row.task_id,
        });
      }
    } else if (!minutes) {
      if (existing.length > 1) {
        const ok = await confirmDialog({
          title: 'Delete these entries?',
          message: `This cell has ${existing.length} entries (${fmtHours(sumMinutes(existing) / 60)} in total). All of them will be deleted.`,
          confirmLabel: 'Delete all',
          danger: true,
        });
        if (!ok) return reset();
      }
      for (const entry of existing) await deleteEntry(entry.id);
    } else if (existing.length > 1) {
      // Several entries in one cell: keep the first with the new total and
      // its notes combined, and remove the rest
      const [first, ...rest] = existing;
      const notes = existing.map(e => e.note).filter(Boolean);
      await updateEntry(first.id, { minutes, note: notes.length ? notes.join('; ') : null });
      for (const entry of rest) await deleteEntry(entry.id);
    } else if (minutes !== existing[0].minutes) {
      await updateEntry(existing[0].id, { minutes });
    }
  } catch (error) {
    toast(errorMessage(error), 'error');
    reset();
  }
}

// Entries list -----------------------------------------------------------------

function splitNote(entry) {
  if (entry.business_unit !== 'shared' || entry.education_share == null) return '';
  const edu = Math.round(entry.education_share * 100);
  return `<span class="muted small split-note">${edu}% Education · ${100 - edu}% Planning Center</span>`;
}

function drawEntries(page) {
  const box = page.el.querySelector('[data-entries]');
  const editable = canEdit(page);
  if (!page.entries.length) {
    box.innerHTML = '<p class="muted">No entries this week.</p>';
    return;
  }
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table entries-table">
        <thead><tr><th>Date</th><th>Campaign / task</th><th class="num">Hours</th><th>Note</th>${editable ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${page.entries.map(entry => {
            const { weekday, day } = dayParts(entry.entry_date);
            return `
              <tr data-id="${esc(entry.id)}">
                <td class="nowrap">${esc(weekday)} ${esc(day)}</td>
                <td>
                  ${entry.campaign ? buTag(entry.campaign.business_unit) : '<span class="tag tag-internal">Internal</span>'}
                  ${esc(entryLabel(entry))}
                  ${splitNote(entry)}
                </td>
                <td class="num nowrap">${fmtHours(entry.minutes / 60)}</td>
                <td>${esc(entry.note || '')}</td>
                ${editable ? `<td class="nowrap row-actions">
                  <button class="btn btn-small" type="button" data-edit>Edit</button>
                  <button class="btn btn-small btn-danger-outline" type="button" data-delete>Delete</button>
                </td>` : ''}
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll('tr[data-id]').forEach(row => {
    const entry = page.entries.find(e => e.id === row.dataset.id);
    row.querySelector('[data-edit]')?.addEventListener('click', () =>
      openTimeEntryForm({ entry }).catch(error => toast(errorMessage(error), 'error')));
    row.querySelector('[data-delete]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete entry?',
        message: `${fmtHours(entry.minutes / 60)} on ${entryLabel(entry)} will be deleted.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteEntry(entry.id);
        toast('Entry deleted');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    });
  });
}
