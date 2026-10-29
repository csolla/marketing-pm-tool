import { supabase } from '../supabase.js';
import { state, canEditWork } from '../state.js';
import { onLiveChange } from '../realtime.js';
import {
  currentMonth, shiftMonth, monthFirst, monthLast, monthName, periodFor, availability, productive,
  monthBudget, capacityPeople, loadBudgets, loadHolidays, loadTimeOff, loadTeamSettings,
} from '../capacity.js';
import { budgetBars, budgetStatus, trendChart, trendTable } from '../charts.js';
import { esc, buTag, avatar, fmtDate, fmtHours, toast, errorMessage, BUSINESS_UNITS } from '../ui.js';

// Kept between visits, so Present shows the same period
const view = { month: currentMonth(), mode: 'month', trendMonths: 6, upcomingMonths: 3, unit: null, trendAsTable: false };

const UNITS = { education: 'Education', planning_center: 'Planning Center' };
const sum = (list, field) => list.reduce((total, row) => total + Number(row[field] || 0), 0);

export async function renderDashboards(el, { present = false } = {}) {
  document.body.classList.toggle('presenting', present);
  el.innerHTML = `
    <div class="page-header dash-header">
      <div>
        <h1>Dashboards</h1>
        <p class="muted" data-period-label></p>
      </div>
      <div class="actions">
        ${present
          ? '<a class="btn" href="#/dashboards">Exit present view</a>'
          : `<button class="btn" type="button" data-export="xlsx">Download Excel</button>
             <button class="btn" type="button" data-export="csv">CSV</button>
             <a class="btn btn-primary" href="#/dashboards/present">Present</a>`}
      </div>
    </div>
    <div class="dash-controls">
      <div class="week-nav">
        <button class="btn" type="button" data-month="-1" aria-label="Previous month">‹</button>
        <input type="month" data-month-input value="${view.month}" aria-label="Month">
        <button class="btn" type="button" data-month="1" aria-label="Next month">›</button>
      </div>
      <div class="view-switch" role="group" aria-label="Period">
        <button type="button" data-mode="month" aria-pressed="${view.mode === 'month'}">Month</button>
        <button type="button" data-mode="quarter" aria-pressed="${view.mode === 'quarter'}">This quarter</button>
      </div>
    </div>
    <div data-dash><p class="muted">Loading figures…</p></div>`;

  const rerender = () => renderDashboards(el, { present });
  el.querySelectorAll('[data-month]').forEach(button => button.addEventListener('click', () => {
    view.month = shiftMonth(view.month, Number(button.dataset.month) * (view.mode === 'quarter' ? 3 : 1));
    rerender();
  }));
  el.querySelector('[data-month-input]').addEventListener('change', event => {
    if (event.target.value) {
      view.month = event.target.value;
      rerender();
    }
  });
  el.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    view.mode = button.dataset.mode;
    rerender();
  }));

  const loadAndDraw = async () => {
    let data;
    try {
      data = await loadData();
    } catch (error) {
      const box = el.querySelector('[data-dash]');
      if (box) box.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
      return;
    }
    if (!el.isConnected) return;
    el.querySelector('[data-period-label]').textContent = data.period.label;
    draw(el, data);
    el.querySelectorAll('[data-export]').forEach(button => {
      button.onclick = () => exportFigures(button.dataset.export, data).catch(error => toast(errorMessage(error), 'error'));
    });
  };
  await loadAndDraw();
  onLiveChange(el, 'time-changed', loadAndDraw, { delay: 1000 });
}

// Everything the page needs for the chosen period ------------------------------

async function loadData() {
  const period = periodFor(view.month, view.mode);
  const lastMonth = period.months[period.months.length - 1];
  const trendFrom = shiftMonth(lastMonth, -(view.trendMonths - 1));
  const upcomingTo = monthLast(shiftMonth(lastMonth, view.upcomingMonths));

  const query = async q => {
    const { data, error } = await q;
    if (error) throw error;
    return data;
  };
  // Holidays and time off cover the whole trend, for each month's automatic budget
  const windowFrom = monthFirst(trendFrom < period.months[0] ? trendFrom : period.months[0]);
  const [budgets, monthly, entries, campaigns, totals, holidays, timeOff, settings] = await Promise.all([
    loadBudgets(trendFrom < period.months[0] ? trendFrom : period.months[0], lastMonth),
    query(supabase.from('monthly_unit_hours').select('*').gte('month', monthFirst(trendFrom)).lte('month', monthFirst(lastMonth))),
    query(supabase.from('time_entries')
      .select('person_id, campaign_id, hours, education_hours, planning_center_hours, internal_hours')
      .gte('entry_date', period.from).lte('entry_date', period.to)),
    query(supabase.from('campaigns').select('id, name, business_unit, status, start_date, end_date, planned_hours').order('name')),
    query(supabase.from('campaign_hours').select('*')),
    loadHolidays(windowFrom, period.to),
    loadTimeOff({ from: windowFrom, to: period.to }),
    loadTeamSettings(),
  ]);
  return { period, trendFrom, upcomingTo, budgets, monthly, entries, campaigns, totals, holidays, timeOff, settings };
}

function draw(el, data) {
  const box = el.querySelector('[data-dash]');
  box.innerHTML = `
    <section class="card dash-section">
      <h2>Budget overview</h2>
      <p class="muted small">Hours used against each unit's budget for ${esc(data.period.label)}. Shared hours are already split. Click a unit to see its campaigns below.</p>
      <div class="budget-bars" data-budget-bars></div>
      <p class="internal-line" data-internal></p>
    </section>
    <section class="card dash-section">
      <div class="section-head">
        <h2>Trend</h2>
        <div class="view-switch" role="group" aria-label="Months shown">
          <button type="button" data-trend="6" aria-pressed="${view.trendMonths === 6}">6 months</button>
          <button type="button" data-trend="12" aria-pressed="${view.trendMonths === 12}">12 months</button>
        </div>
        <button class="btn btn-small btn-ghost" type="button" data-trend-table>${view.trendAsTable ? 'Show as chart' : 'Show as table'}</button>
      </div>
      <div data-trend-chart></div>
    </section>
    <section class="card dash-section">
      <div class="section-head">
        <h2>By campaign</h2>
        <span data-unit-filter></span>
      </div>
      <div data-campaigns></div>
    </section>
    <section class="card dash-section">
      <h2>Team capacity</h2>
      <p class="muted small">Productive hours available after time off and bank holidays, against campaign hours logged in the period.</p>
      <div data-capacity></div>
    </section>
    <section class="card dash-section">
      <div class="section-head">
        <h2>Upcoming</h2>
        <div class="view-switch" role="group" aria-label="Months ahead">
          ${[1, 2, 3].map(n => `<button type="button" data-upcoming="${n}" aria-pressed="${view.upcomingMonths === n}">${n} month${n === 1 ? '' : 's'}</button>`).join('')}
        </div>
      </div>
      <div data-upcoming-list></div>
    </section>`;

  const rerender = () => renderDashboards(el, { present: document.body.classList.contains('presenting') });
  box.querySelectorAll('[data-trend]').forEach(button => button.addEventListener('click', () => {
    view.trendMonths = Number(button.dataset.trend);
    rerender();
  }));
  box.querySelectorAll('[data-upcoming]').forEach(button => button.addEventListener('click', () => {
    view.upcomingMonths = Number(button.dataset.upcoming);
    rerender();
  }));
  box.querySelector('[data-trend-table]').addEventListener('click', () => {
    view.trendAsTable = !view.trendAsTable;
    box.querySelector('[data-trend-table]').textContent = view.trendAsTable ? 'Show as chart' : 'Show as table';
    drawTrend(box, data);
  });

  drawBudget(box, data);
  drawTrend(box, data);
  drawCampaigns(box, data);
  drawCapacity(box, data);
  drawUpcoming(box, data);
}

// Figures, shared by the page and the export ---------------------------------------

// Automatic from productive capacity unless typed in Settings
function budgetFor(data, month) {
  return monthBudget(month, {
    people: capacityPeople(state.people),
    holidays: data.holidays,
    timeOff: data.timeOff,
    settings: data.settings,
    override: data.budgets[month],
  });
}

function budgetFigures(data) {
  const months = data.period.months.map(m => budgetFor(data, m));
  const budget = key => months.reduce((total, b) => total + b[key], 0);
  return [
    { key: 'education', label: 'Education', used: sum(data.entries, 'education_hours'), budget: budget('education') || null },
    { key: 'planning_center', label: 'Planning Center', used: sum(data.entries, 'planning_center_hours'), budget: budget('planning_center') || null },
  ];
}

function trendFigures(data) {
  const months = [];
  for (let m = data.trendFrom; m <= data.period.months[data.period.months.length - 1]; m = shiftMonth(m, 1)) months.push(m);
  return months.map(month => {
    const row = data.monthly.find(r => r.month.slice(0, 7) === month) || {};
    const budget = budgetFor(data, month);
    const [y, mm] = month.split('-').map(Number);
    const short = new Date(y, mm - 1, 1).toLocaleDateString('en-GB', { month: 'short' });
    return {
      month,
      label: mm === 1 || month === months[0] ? `${short} ${String(y).slice(2)}` : short,
      fullLabel: monthName(month),
      edu: Number(row.education_hours || 0),
      pc: Number(row.planning_center_hours || 0),
      internal: Number(row.internal_hours || 0),
      eduBudget: Math.round(budget.education) || null,
      pcBudget: Math.round(budget.planning_center) || null,
      highlight: data.period.months.includes(month),
    };
  });
}

function campaignFigures(data) {
  const { from, to } = data.period;
  return data.campaigns
    .map(c => {
      const mine = data.entries.filter(e => e.campaign_id === c.id);
      const total = Number(data.totals.find(t => t.campaign_id === c.id)?.hours || 0);
      return {
        ...c,
        period: sum(mine, 'hours'),
        periodEdu: sum(mine, 'education_hours'),
        periodPc: sum(mine, 'planning_center_hours'),
        total,
        overPlan: Number(c.planned_hours) > 0 && total > Number(c.planned_hours),
        overlaps: (!c.start_date || c.start_date <= to) && (!c.end_date || c.end_date >= from),
      };
    })
    .filter(c => c.period > 0 || (c.overlaps && (c.start_date || c.end_date)))
    .sort((a, b) => b.period - a.period || a.name.localeCompare(b.name));
}

function capacityFigures(data) {
  const ids = new Set(data.entries.map(e => e.person_id));
  return state.people
    .filter(p => (p.active && p.counts_in_capacity) || (ids.has(p.id) && p.counts_in_capacity))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(person => {
      const mine = data.entries.filter(e => e.person_id === person.id);
      const available = availability(person, data.period.from, data.period.to, data.holidays, data.timeOff);
      const productiveHours = productive(available.hours, data.settings);
      const edu = sum(mine, 'education_hours');
      const pc = sum(mine, 'planning_center_hours');
      // Internal time is part of the non-productive share, so only campaign
      // hours count against productive hours
      return {
        person,
        available,
        productiveHours,
        logged: sum(mine, 'hours'),
        campaign: edu + pc,
        edu,
        pc,
        internal: sum(mine, 'internal_hours'),
        used: productiveHours ? Math.round((edu + pc) / productiveHours * 100) : null,
      };
    });
}

function upcomingFigures(data) {
  return data.campaigns
    .filter(c => c.start_date && c.start_date > data.period.to && c.start_date <= data.upcomingTo)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

// Sections -------------------------------------------------------------------------

function drawBudget(box, data) {
  const units = budgetFigures(data);
  const container = box.querySelector('[data-budget-bars]');
  container.innerHTML = budgetBars(units, view.unit);
  container.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
    view.unit = view.unit === button.dataset.unit ? null : button.dataset.unit;
    drawBudget(box, data);
    drawCampaigns(box, data);
  }));
  box.querySelector('[data-internal]').innerHTML =
    `<span class="swatch swatch-internal" aria-hidden="true"></span> <strong>Internal</strong> ${fmtHours(sum(data.entries, 'internal_hours'))}
     <span class="muted">· meetings, admin and training; counts towards capacity, not against either budget</span>`;
}

function drawTrend(box, data) {
  const container = box.querySelector('[data-trend-chart]');
  const months = trendFigures(data);
  if (view.trendAsTable) container.innerHTML = trendTable(months);
  else trendChart(container, months);
}

function drawCampaigns(box, data) {
  const filter = box.querySelector('[data-unit-filter]');
  filter.innerHTML = view.unit
    ? `<span class="filter-chip">${esc(UNITS[view.unit])} only <button type="button" class="icon-btn" data-clear-unit aria-label="Show all units">×</button></span>`
    : '';
  filter.querySelector('[data-clear-unit]')?.addEventListener('click', () => {
    view.unit = null;
    drawBudget(box, data);
    drawCampaigns(box, data);
  });

  let rows = campaignFigures(data);
  if (view.unit) rows = rows.filter(c => c.business_unit === view.unit || c.business_unit === 'shared');
  const container = box.querySelector('[data-campaigns]');
  if (!rows.length) {
    container.innerHTML = `<p class="muted">No campaigns ${view.unit ? `for ${esc(UNITS[view.unit])} ` : ''}in this period.</p>`;
    return;
  }
  const hoursThisPeriod = c => (view.unit === 'education' ? c.periodEdu : view.unit === 'planning_center' ? c.periodPc : c.period);
  const name = c => (canEditWork() && !document.body.classList.contains('presenting')
    ? `<a class="row-link" href="#/campaigns/${esc(c.id)}">${esc(c.name)}</a>` : `<strong>${esc(c.name)}</strong>`);
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Campaign</th><th>Business unit</th><th>Dates</th><th class="num">Planned</th>
          <th class="num">${view.unit ? `${esc(UNITS[view.unit])} hours` : 'Hours'} this period</th><th class="num">Total so far</th></tr></thead>
        <tbody>
          ${rows.map(c => `
            <tr>
              <td>${name(c)}</td>
              <td>${buTag(c.business_unit)}</td>
              <td class="nowrap muted">${c.start_date ? esc(fmtDate(c.start_date)) : ''}${c.end_date ? ` – ${esc(fmtDate(c.end_date))}` : ''}</td>
              <td class="num">${fmtHours(c.planned_hours)}</td>
              <td class="num"><strong>${fmtHours(hoursThisPeriod(c))}</strong></td>
              <td class="num nowrap">${fmtHours(c.total)}${c.overPlan
                ? ` <span class="status-chip status-critical"><span aria-hidden="true">!</span> Over plan</span>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${view.unit ? '<p class="muted small table-note">Shared campaigns show only this unit\'s share of their hours this period.</p>' : ''}`;
}

function drawCapacity(box, data) {
  const rows = capacityFigures(data);
  const container = box.querySelector('[data-capacity]');
  if (!rows.length) {
    container.innerHTML = '<p class="muted">Nobody counts in capacity yet. Set it in Settings > Capacity.</p>';
    return;
  }
  const pct = Number(data.settings.productive_pct ?? 80);
  const total = key => rows.reduce((t, r) => t + (key === 'available' ? r.available.hours : r[key]), 0);
  const teamUsed = total('productiveHours') ? `${Math.round(total('campaign') / total('productiveHours') * 100)}%` : '—';
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table capacity-table">
        <thead><tr><th>Person</th><th class="num">Working hours</th><th class="num">Productive (${pct}%)</th>
          <th class="num">Campaign hours</th><th class="meter-col">Used</th>
          <th class="num">Education</th><th class="num">Planning Center</th><th class="num">Internal</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const note = [
              r.available.holidayDays ? `${r.available.holidayDays} bank holiday${r.available.holidayDays === 1 ? '' : 's'}` : '',
              r.available.offDays ? `${r.available.offDays} day${r.available.offDays === 1 ? '' : 's'} off` : '',
            ].filter(Boolean).join(', ');
            return `
              <tr>
                <td><span class="person">${avatar(r.person, 24)}<span>${esc(r.person.name)}${note ? `<br><span class="muted small">${esc(note)}</span>` : ''}</span></span></td>
                <td class="num muted">${fmtHours(r.available.hours)}</td>
                <td class="num">${fmtHours(r.productiveHours)}</td>
                <td class="num"><strong>${fmtHours(r.campaign)}</strong></td>
                <td class="meter-col">${r.used == null ? '<span class="muted">—</span>' : `
                  <span class="mini-meter" aria-hidden="true"><span style="width:${Math.min(100, r.used)}%"></span></span>
                  <span class="nowrap">${r.used}%</span>`}</td>
                <td class="num">${fmtHours(r.edu)}</td>
                <td class="num">${fmtHours(r.pc)}</td>
                <td class="num">${fmtHours(r.internal)}</td>
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr><th>Team</th><th class="num">${fmtHours(total('available'))}</th><th class="num">${fmtHours(total('productiveHours'))}</th>
            <th class="num">${fmtHours(total('campaign'))}</th><th class="meter-col">${teamUsed}</th>
            <th class="num">${fmtHours(total('edu'))}</th><th class="num">${fmtHours(total('pc'))}</th><th class="num">${fmtHours(total('internal'))}</th></tr>
        </tfoot>
      </table>
    </div>
    <p class="muted small table-note">Working hours are after bank holidays and time off. Productive is ${pct}% of that; the rest covers
      internal meetings, admin and non-productive time, so Internal hours aren't counted in "Used".</p>`;
}

function drawUpcoming(box, data) {
  const rows = upcomingFigures(data);
  const container = box.querySelector('[data-upcoming-list]');
  if (!rows.length) {
    container.innerHTML = `<p class="muted">No campaigns start between ${esc(fmtDate(data.period.to))} and ${esc(fmtDate(data.upcomingTo))}.</p>`;
    return;
  }
  const byUnit = key => rows.filter(c => c.business_unit === key).reduce((t, c) => t + Number(c.planned_hours), 0);
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Campaign</th><th>Business unit</th><th>Starts</th><th>Ends</th><th class="num">Planned hours</th></tr></thead>
        <tbody>
          ${rows.map(c => `
            <tr><td><strong>${esc(c.name)}</strong></td><td>${buTag(c.business_unit)}</td>
              <td class="nowrap">${esc(fmtDate(c.start_date))}</td><td class="nowrap">${esc(fmtDate(c.end_date) || '—')}</td>
              <td class="num">${fmtHours(c.planned_hours)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted small table-note">Planned: ${Object.entries(BUSINESS_UNITS).map(([k, label]) => `${esc(label)} ${fmtHours(byUnit(k))}`).join(' · ')}</p>`;
}

// Export ---------------------------------------------------------------------------

function exportSheets(data) {
  const h = v => Math.round(Number(v || 0) * 100) / 100;
  const label = data.period.label;
  const lastMonth = data.period.months[data.period.months.length - 1];
  const sheets = [
    {
      name: 'Budget',
      period: label,
      rows: [
        ['Business unit', 'Hours used', 'Budget', '% used', 'Status'],
        ...budgetFigures(data).map(u => [u.label, h(u.used), u.budget == null ? '' : h(u.budget),
          u.budget ? Math.round(u.used / u.budget * 100) : '', budgetStatus(u.used, u.budget).label]),
        ['Internal', h(sum(data.entries, 'internal_hours')), '', '', 'Not counted against budgets'],
      ],
    },
    {
      name: 'Trend',
      period: `${monthName(data.trendFrom)} – ${monthName(lastMonth)} (selected: ${label})`,
      rows: [
        ['Month', 'Education hours', 'Education budget', 'Planning Center hours', 'Planning Center budget', 'Internal hours'],
        ...trendFigures(data).map(m => [m.fullLabel, h(m.edu), m.eduBudget ?? '', h(m.pc), m.pcBudget ?? '', h(m.internal)]),
      ],
    },
    {
      name: 'Campaigns',
      period: label,
      rows: [
        ['Campaign', 'Business unit', 'Start', 'End', 'Planned hours', 'Hours this period', 'Education share', 'Planning Center share', 'Total so far', 'Over plan'],
        ...campaignFigures(data).map(c => [c.name, BUSINESS_UNITS[c.business_unit], c.start_date || '', c.end_date || '',
          h(c.planned_hours), h(c.period), h(c.periodEdu), h(c.periodPc), h(c.total), c.overPlan ? 'Yes' : '']),
      ],
    },
    {
      name: 'Team capacity',
      period: label,
      rows: [
        ['Person', 'Working days', 'Bank holidays', 'Days off', 'Working hours', `Productive hours (${data.settings.productive_pct ?? 80}%)`,
          'Campaign hours', '% of productive used', 'Education', 'Planning Center', 'Internal'],
        ...capacityFigures(data).map(r => [r.person.name, r.available.workDays, r.available.holidayDays, r.available.offDays,
          h(r.available.hours), h(r.productiveHours), h(r.campaign), r.used ?? '', h(r.edu), h(r.pc), h(r.internal)]),
      ],
    },
    {
      name: 'Upcoming',
      period: `Campaigns starting after ${fmtDate(data.period.to)}, up to ${fmtDate(data.upcomingTo)}`,
      rows: [
        ['Campaign', 'Business unit', 'Start', 'End', 'Planned hours'],
        ...upcomingFigures(data).map(c => [c.name, BUSINESS_UNITS[c.business_unit], c.start_date, c.end_date || '', h(c.planned_hours)]),
      ],
    },
  ];
  // Every sheet starts by saying which period it covers
  return sheets.map(sheet => ({ ...sheet, rows: [['Period', sheet.period], [], ...sheet.rows] }));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// SheetJS is only loaded when someone downloads Excel
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('Could not load the Excel library. Try the CSV download instead.'));
    document.head.append(script);
  });
}

async function exportFigures(format, data) {
  const sheets = exportSheets(data);
  const base = `marketing-dashboard-${view.mode === 'quarter' ? data.period.label.split(' (')[0].replace(' ', '-') : view.month}`;
  if (format === 'csv') {
    const cell = v => {
      const text = String(v ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = sheets.map(s => [[s.name], ...s.rows].map(row => row.map(cell).join(',')).join('\n')).join('\n\n');
    download(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
    return;
  }
  const XLSX = await loadSheetJs();
  const book = XLSX.utils.book_new();
  sheets.forEach(s => XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(s.rows), s.name));
  XLSX.writeFile(book, `${base}.xlsx`);
}
