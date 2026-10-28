import { state, canEditWork, isAdmin } from '../state.js';
import { onLiveChange } from '../realtime.js';
import { todayIso } from '../tasks.js';
import {
  parseHours, hoursText, weekStart, addDays, loadEntries, createEntry, updateEntry, deleteEntry, entryLabel,
} from '../time.js';
import { startTimer } from '../timer.js';
import { esc, options, buTag, fmtHours, toast, errorMessage, confirmDialog } from '../ui.js';
import { openTimeEntryForm, pickCampaignTask } from './time-entry-form.js';
import { renderTeamTime } from './team-time.js';

const WEEKEND_KEY = 'my-time-show-weekend';

function savedShowWeekend() {
  try { return localStorage.getItem(WEEKEND_KEY) === '1'; } catch { return false; }
}

const rowKey = e => `${e.campaign_id || 'internal'}|${e.task_id || ''}`;
const sumMinutes = entries => entries.reduce((sum, e) => sum + e.minutes, 0);

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

export async function renderMyTime(el) {
  const page = {
    el,
    personId: state.me.id,
    start: weekStart(todayIso()),
    showWeekend: savedShowWeekend(),
    extraRows: [],
    entries: [],
    loadId: 0,
  };
  const people = state.people.filter(p => p.role !== 'director' && (p.active || p.id === state.me.id));

  el.innerHTML = `
    <div class="page-header">
      <h1 data-title>My time</h1>
      <div class="actions" data-actions></div>
    </div>
    <div class="time-controls">
      <div class="week-nav">
        <button class="btn" type="button" data-week="-7" aria-label="Previous week">‹</button>
        <button class="btn" type="button" data-week="0">This week</button>
        <button class="btn" type="button" data-week="7" aria-label="Next week">›</button>
        <strong data-week-label></strong>
      </div>
      <label class="inline-field">Person
        <select data-person>${options(Object.fromEntries(people.map(p => [p.id, p.name])), page.personId)}</select>
      </label>
      <label class="toggle"><input type="checkbox" data-weekend ${page.showWeekend ? 'checked' : ''}> Show weekend</label>
    </div>
    <div data-grid><p class="muted">Loading…</p></div>
    <section class="section">
      <h2>Entries this week</h2>
      <div data-entries></div>
    </section>
    ${isAdmin() ? '<section class="section team-time" data-team></section>' : ''}`;

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

  await load(page);
  onLiveChange(el, 'time-changed', () => load(page));
}

function showPerson(page, personId) {
  page.personId = personId;
  page.extraRows = [];
  page.el.querySelector('[data-person]').value = personId;
  load(page);
}

async function load(page) {
  const loadId = ++page.loadId;
  page.el.querySelector('[data-week-label]').textContent = weekLabel(page.start);
  try {
    const entries = await loadEntries(page.personId, page.start, addDays(page.start, 6));
    if (loadId !== page.loadId) return;
    page.entries = entries;
    draw(page);
    const team = page.el.querySelector('[data-team]');
    if (team) {
      renderTeamTime(team, {
        week: page.start,
        onPickPerson: id => {
          showPerson(page, id);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
      });
    }
  } catch (error) {
    page.el.querySelector('[data-grid]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
  }
}

function drawHeader(page) {
  const { el } = page;
  const person = state.people.find(p => p.id === page.personId);
  const own = page.personId === state.me.id;
  el.querySelector('[data-title]').textContent = own ? 'My time' : `Time: ${person?.name || ''}`;

  const actions = el.querySelector('[data-actions]');
  actions.innerHTML = canEdit(page) ? `
    <button class="btn" type="button" data-add-row>Add row</button>
    ${own ? '<button class="btn" type="button" data-start>Start timer</button>' : ''}
    <button class="btn btn-primary" type="button" data-add>Add time</button>` : '';
  actions.querySelector('[data-add-row]')?.addEventListener('click', () => pickCampaignTask({
    onPicked: picked => {
      page.extraRows.push({
        campaign_id: picked.campaign_id,
        task_id: picked.task_id,
        campaign: picked.campaign,
        task: picked.task_id ? { title: picked.taskTitle } : null,
      });
      draw(page);
    },
  }));
  actions.querySelector('[data-start]')?.addEventListener('click', () => startTimer());
  actions.querySelector('[data-add]')?.addEventListener('click', () =>
    openTimeEntryForm({ personId: page.personId, defaults: { entry_date: defaultDate(page) } })
      .catch(error => toast(errorMessage(error), 'error')));
}

// Today if it's in the week shown, otherwise that week's Monday
function defaultDate(page) {
  const today = todayIso();
  return today >= page.start && today <= addDays(page.start, 6) ? today : page.start;
}

function draw(page) {
  drawHeader(page);
  drawGrid(page);
  drawEntries(page);
}

// Weekly grid ----------------------------------------------------------------

function buildRows(page) {
  const rows = new Map();
  page.entries.forEach(e => {
    const key = rowKey(e);
    if (!rows.has(key)) rows.set(key, { key, campaign_id: e.campaign_id, task_id: e.task_id, label: entryLabel(e), campaign: e.campaign });
  });
  page.extraRows.forEach(r => {
    const key = rowKey(r);
    if (!rows.has(key)) rows.set(key, { key, campaign_id: r.campaign_id, task_id: r.task_id, label: entryLabel(r), campaign: r.campaign });
  });
  return [...rows.values()].sort((a, b) =>
    (a.campaign ? 0 : 1) - (b.campaign ? 0 : 1) || a.label.localeCompare(b.label));
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

  grid.innerHTML = `
    <div class="table-wrap">
      <table class="table time-grid">
        <thead>
          <tr>
            <th>Campaign / task</th>
            ${days.map(day => {
              const { weekday, day: date } = dayParts(day);
              return `<th class="num ${day === today ? 'is-today' : ''}">${esc(weekday)}<br><span class="muted">${esc(date)}</span></th>`;
            }).join('')}
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(row => `
            <tr>
              <td class="row-label">
                ${row.campaign ? buTag(row.campaign.business_unit) : '<span class="tag tag-internal">Internal</span>'}
                <span>${esc(row.label)}</span>
              </td>
              ${days.map(day => {
                const entries = cellEntries(row.key, day);
                const minutes = sumMinutes(entries);
                const { weekday } = dayParts(day);
                if (entries.length > 1) {
                  return `<td class="cell"><span class="cell-multi" title="${entries.length} entries: edit them in the list below">${esc(hoursText(minutes))}</span></td>`;
                }
                return `<td class="cell"><input class="cell-input" data-cell="${esc(row.key)}@${day}" inputmode="decimal"
                  value="${esc(hoursText(minutes))}" aria-label="${esc(row.label)}, ${esc(weekday)}" ${editable ? '' : 'disabled'}></td>`;
              }).join('')}
              <td class="num total">${fmtHours(sumMinutes(page.entries.filter(e => rowKey(e) === row.key)) / 60)}</td>
            </tr>`).join('') : `
            <tr><td colspan="${days.length + 2}" class="muted empty-row">
              No time logged this week.${editable ? ' Use “Add row” to start a row, or “Add time”.' : ''}
            </td></tr>`}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            ${days.map(day => `<th class="num">${fmtHours(dayTotal(day) / 60)}</th>`).join('')}
            <th class="num week-total">${fmtHours(sumMinutes(page.entries) / 60)}</th>
          </tr>
        </tfoot>
      </table>
    </div>`;

  grid.querySelectorAll('.cell-input').forEach(input => {
    input.addEventListener('change', () => saveCell(page, input));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
  });

  if (focused) {
    const input = grid.querySelector(`[data-cell="${CSS.escape(focused.cell)}"]`);
    if (input) {
      if (focused.value !== focused.original) input.value = focused.value;
      input.focus();
    }
  }
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
      await deleteEntry(existing[0].id);
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
