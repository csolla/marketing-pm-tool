import { supabase } from '../supabase.js';
import { state, canEditWork } from '../state.js';
import { onLiveChange } from '../realtime.js';
import {
  currentMonth, shiftMonth, monthFirst, monthLast, monthName, periodFor, availability, productive,
  monthBudget, capacityPeople, loadBudgets, loadHolidays, loadTimeOff, loadTeamSettings,
} from '../capacity.js';
import { budgetBars, budgetStatus, trendChart, trendTable } from '../charts.js';
import { esc, buTag, avatar, fmtDate, fmtHours, toast, errorMessage, BUSINESS_UNITS } from '../ui.js';

// Open Dashboards on a given month (used by budget alerts)
export function showDashboardMonth(month) {
  view.month = month;
  view.mode = 'month';
}

// Kept between visits, so Present shows the same period
// focus: null (both units), 'education' or 'planning_center'; slide: Present
const view = { month: currentMonth(), mode: 'month', trendMonths: 6, upcomingMonths: 3, focus: null, trendAsTable: false, slide: 0 };

const SECTIONS = [
  { id: 'headline', label: 'Headlines' },
  { id: 'budget', label: 'Budget' },
  { id: 'trend', label: 'Trend' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'capacity', label: 'Team' },
  { id: 'upcoming', label: 'Upcoming' },
];
let presentKeys = null;

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
      <div class="view-switch" role="group" aria-label="Business unit">
        <button type="button" data-focus="" aria-pressed="${!view.focus}">Both units</button>
        <button type="button" data-focus="education" aria-pressed="${view.focus === 'education'}">Education</button>
        <button type="button" data-focus="planning_center" aria-pressed="${view.focus === 'planning_center'}">Planning Center</button>
      </div>
    </div>
    ${present ? '' : `<nav class="dash-menu" aria-label="Dashboard sections">
      ${SECTIONS.map(sec => `<button type="button" data-jump="${sec.id}">${esc(sec.label)}</button>`).join('')}
    </nav>`}
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
  el.querySelectorAll('[data-focus]').forEach(button => button.addEventListener('click', () => {
    view.focus = button.dataset.focus || null;
    rerender();
  }));
  el.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () =>
    el.querySelector(`#dash-${button.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));

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
  // The period before, for the headline changes
  const previous = periodFor(shiftMonth(period.months[0], view.mode === 'quarter' ? -3 : -1), view.mode);
  // Holidays, time off and budgets cover the trend and the previous period
  const firstMonth = [trendFrom, period.months[0], previous.months[0]].sort()[0];
  const windowFrom = monthFirst(firstMonth);
  const [budgets, monthly, entries, campaigns, totals, holidays, timeOff, settings, previousEntries] = await Promise.all([
    loadBudgets(firstMonth, lastMonth),
    query(supabase.from('monthly_unit_hours').select('*').gte('month', monthFirst(trendFrom)).lte('month', monthFirst(lastMonth))),
    query(supabase.from('time_entries')
      .select('person_id, campaign_id, hours, education_hours, planning_center_hours, internal_hours')
      .gte('entry_date', period.from).lte('entry_date', period.to)),
    query(supabase.from('campaigns').select('id, name, business_unit, status, start_date, end_date, planned_hours').order('name')),
    query(supabase.from('campaign_hours').select('*')),
    loadHolidays(windowFrom, period.to),
    loadTimeOff({ from: windowFrom, to: period.to }),
    loadTeamSettings(),
    query(supabase.from('time_entries').select('person_id, education_hours, planning_center_hours')
      .gte('entry_date', previous.from).lte('entry_date', previous.to)),
  ]);
  return {
    period, previous, trendFrom, upcomingTo, budgets, monthly, entries, campaigns, totals, holidays, timeOff, settings, previousEntries,
  };
}

function draw(el, data) {
  const box = el.querySelector('[data-dash]');
  const present = document.body.classList.contains('presenting');
  box.innerHTML = `
    <section class="dash-section dash-headline" id="dash-headline">
      <h2 class="${present ? '' : 'visually-hidden'}">Headlines</h2>
      <div class="kpis" data-kpis></div>
    </section>
    <section class="card dash-section" id="dash-budget">
      <h2>Budget overview</h2>
      <p class="muted small">Hours used against each unit's budget for ${esc(data.period.label)}. Shared hours are already split. Click a unit to focus the whole page on it.</p>
      <div class="budget-bars" data-budget-bars></div>
      <p class="internal-line" data-internal></p>
    </section>
    <section class="card dash-section" id="dash-trend">
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
    <section class="card dash-section" id="dash-campaigns">
      <div class="section-head">
        <h2>By campaign</h2>
        <span data-unit-filter></span>
      </div>
      <div data-campaigns></div>
    </section>
    <section class="card dash-section" id="dash-capacity">
      <h2>Team capacity</h2>
      <p class="muted small">Productive hours available after time off and bank holidays, against campaign hours logged in the period.</p>
      <div data-capacity></div>
    </section>
    <section class="card dash-section" id="dash-upcoming">
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

  drawHeadlines(box, data);
  drawBudget(box, data);
  drawTrend(box, data);
  drawCampaigns(box, data);
  drawCapacity(box, data);
  drawUpcoming(box, data);
  if (present) setUpSlides(el, box);
}

// Present: one section per screen, stepped with buttons or arrow keys
function setUpSlides(el, box) {
  const sections = [...box.querySelectorAll('.dash-section')];
  view.slide = Math.min(view.slide, sections.length - 1);
  const bar = document.createElement('div');
  bar.className = 'slide-bar';
  bar.innerHTML = `
    <button class="btn" type="button" data-prev aria-label="Previous section">← Previous</button>
    <span class="slide-pos" data-pos></span>
    <button class="btn btn-primary" type="button" data-next aria-label="Next section">Next →</button>`;
  box.append(bar);
  const show = index => {
    view.slide = Math.max(0, Math.min(sections.length - 1, index));
    sections.forEach((section, i) => { section.hidden = i !== view.slide; });
    bar.querySelector('[data-pos]').innerHTML =
      `${view.slide + 1} / ${sections.length} · ${esc(SECTIONS[view.slide]?.label || '')}
       <span class="slide-dots" aria-hidden="true">${sections.map((_, i) => `<span class="${i === view.slide ? 'on' : ''}"></span>`).join('')}</span>`;
    bar.querySelector('[data-prev]').disabled = view.slide === 0;
    bar.querySelector('[data-next]').disabled = view.slide === sections.length - 1;
  };
  bar.querySelector('[data-prev]').addEventListener('click', () => show(view.slide - 1));
  bar.querySelector('[data-next]').addEventListener('click', () => show(view.slide + 1));
  if (presentKeys) document.removeEventListener('keydown', presentKeys);
  presentKeys = event => {
    if (!el.isConnected) {
      document.removeEventListener('keydown', presentKeys);
      presentKeys = null;
      return;
    }
    if (event.target.closest('input, select, textarea')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(view.slide + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); show(view.slide - 1); }
  };
  document.addEventListener('keydown', presentKeys);
  show(view.slide);
}

// Headline figures, with the change since the previous period
function drawHeadlines(box, data) {
  const pct = (used, budget) => (budget ? Math.round(used / budget * 100) : null);
  const prevLabel = view.mode === 'quarter'
    ? data.previous.label.split(' (')[0]
    : monthName(data.previous.months[0], 'short').split(' ')[0];
  const delta = (now, before) => {
    if (now == null || before == null) return '';
    const d = now - before;
    if (d === 0) return `<span class="kpi-delta">No change vs ${esc(prevLabel)}</span>`;
    return `<span class="kpi-delta">${d > 0 ? '↑' : '↓'} ${Math.abs(d)} pts vs ${esc(prevLabel)}</span>`;
  };

  const units = budgetFigures(data);
  const previousUnits = budgetFigures({ ...data, period: data.previous, entries: data.previousEntries });
  const tiles = units
    .filter(u => !view.focus || u.key === view.focus)
    .map(u => {
      const before = previousUnits.find(p => p.key === u.key);
      const now = pct(u.used, u.budget);
      const status = budgetStatus(u.used, u.budget);
      return `
        <div class="kpi">
          <span class="kpi-label"><span class="swatch swatch-${u.key}" aria-hidden="true"></span>${esc(u.label)} budget used</span>
          <strong class="kpi-value">${now == null ? '—' : `${now}%`}</strong>
          <span class="kpi-sub">${fmtHours(u.used)}${u.budget ? ` of ${fmtHours(Math.round(u.budget))}` : ''}
            <span class="status-chip status-${status.key}"><span aria-hidden="true">${status.icon}</span> ${esc(status.label)}</span></span>
          ${delta(now, pct(before.used, before.budget))}
        </div>`;
    });

  // Team: campaign hours against productive hours, now and before
  const team = period => {
    const people = capacityPeople(state.people);
    const entries = period === data.period ? data.entries : data.previousEntries;
    const productiveHours = people.reduce((t, p) =>
      t + productive(availability(p, period.from, period.to, data.holidays, data.timeOff).hours, data.settings), 0);
    const ids = new Set(people.map(p => p.id));
    const campaignHours = entries.filter(e => ids.has(e.person_id))
      .reduce((t, e) => t + Number(e.education_hours) + Number(e.planning_center_hours), 0);
    return { productiveHours, campaignHours, pct: pct(campaignHours, productiveHours) };
  };
  const now = team(data.period);
  const before = team(data.previous);
  tiles.push(`
    <div class="kpi">
      <span class="kpi-label">Team productive time used</span>
      <strong class="kpi-value">${now.pct == null ? '—' : `${now.pct}%`}</strong>
      <span class="kpi-sub">${fmtHours(Math.round(now.campaignHours))} of ${fmtHours(Math.round(now.productiveHours))} on campaigns</span>
      ${delta(now.pct, before.pct)}
    </div>`);

  const active = focusCampaigns(campaignFigures(data));
  const over = active.filter(c => c.overPlan);
  tiles.push(`
    <div class="kpi ${over.length ? 'kpi-alert' : ''}">
      <span class="kpi-label">Campaigns over plan</span>
      <strong class="kpi-value">${over.length}</strong>
      <span class="kpi-sub">of ${active.length} active in the period${over.length ? `: ${esc(over.slice(0, 2).map(c => c.name).join(', '))}${over.length > 2 ? '…' : ''}` : ''}</span>
    </div>`);

  box.querySelector('[data-kpis]').innerHTML = tiles.join('');
}

// Campaigns of the focused unit (Shared ones count for both)
function focusCampaigns(rows) {
  return view.focus ? rows.filter(c => c.business_unit === view.focus || c.business_unit === 'shared') : rows;
}

// Figures, shared by the page and the export ---------------------------------------

// Automatic from productive capacity unless typed in Capacity > Monthly budgets
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
  container.innerHTML = budgetBars(units, view.focus);
  container.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
    view.focus = view.focus === button.dataset.unit ? null : button.dataset.unit;
    box.closest('.page')?.querySelector(`[data-focus="${view.focus || ''}"]`)?.click();
  }));
  box.querySelector('[data-internal]').hidden = Boolean(view.focus);
  box.querySelector('[data-internal]').innerHTML =
    `<span class="swatch swatch-internal" aria-hidden="true"></span> <strong>Internal</strong> ${fmtHours(sum(data.entries, 'internal_hours'))}
     <span class="muted">· meetings, admin and training; counts towards capacity, not against either budget</span>`;
}

function drawTrend(box, data) {
  const container = box.querySelector('[data-trend-chart]');
  const months = trendFigures(data);
  if (view.trendAsTable) container.innerHTML = trendTable(months);
  else trendChart(container, months, { focus: view.focus });
}

function drawCampaigns(box, data) {
  const filter = box.querySelector('[data-unit-filter]');
  filter.innerHTML = view.focus ? `<span class="filter-chip">${esc(UNITS[view.focus])} only</span>` : '';

  const rows = focusCampaigns(campaignFigures(data));
  const container = box.querySelector('[data-campaigns]');
  if (!rows.length) {
    container.innerHTML = `<p class="muted">No campaigns ${view.focus ? `for ${esc(UNITS[view.focus])} ` : ''}in this period.</p>`;
    return;
  }
  const hoursThisPeriod = c => (view.focus === 'education' ? c.periodEdu : view.focus === 'planning_center' ? c.periodPc : c.period);
  const name = c => (canEditWork() && !document.body.classList.contains('presenting')
    ? `<a class="row-link" href="#/campaigns/${esc(c.id)}">${esc(c.name)}</a>` : `<strong>${esc(c.name)}</strong>`);
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Campaign</th><th>Business unit</th><th>Dates</th><th class="num">Planned</th>
          <th class="num">${view.focus ? `${esc(UNITS[view.focus])} hours` : 'Hours'} this period</th><th class="num">Total so far</th></tr></thead>
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
    ${view.focus ? '<p class="muted small table-note">Shared campaigns show only this unit\'s share of their hours this period.</p>' : ''}`;
}

function drawCapacity(box, data) {
  const rows = capacityFigures(data);
  const container = box.querySelector('[data-capacity]');
  if (!rows.length) {
    container.innerHTML = '<p class="muted">Nobody counts in capacity yet. Set it in Capacity → People.</p>';
    return;
  }
  const pct = Number(data.settings.productive_pct ?? 80);
  const total = key => rows.reduce((t, r) => t + (key === 'available' ? r.available.hours : r[key]), 0);
  const teamUsed = total('productiveHours') ? `${Math.round(total('campaign') / total('productiveHours') * 100)}%` : '—';
  // With a unit in focus, only that unit's hours are shown per person
  const columns = view.focus === 'education' ? [['edu', 'Education']]
    : view.focus === 'planning_center' ? [['pc', 'Planning Center']]
      : [['edu', 'Education'], ['pc', 'Planning Center'], ['internal', 'Internal']];
  const unitHead = columns.map(([, label]) => `<th class="num">${label}</th>`).join('');
  const unitCells = (r, tag = 'td') => columns.map(([key]) => `<${tag} class="num">${fmtHours(r[key])}</${tag}>`).join('');
  container.innerHTML = `
    <div class="table-wrap">
      <table class="table capacity-table">
        <thead><tr><th>Person</th><th class="num">Working hours</th><th class="num">Productive (${pct}%)</th>
          <th class="num">Campaign hours</th><th class="meter-col">Used</th>
          ${unitHead}</tr></thead>
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
                ${unitCells(r)}
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr><th>Team</th><th class="num">${fmtHours(total('available'))}</th><th class="num">${fmtHours(total('productiveHours'))}</th>
            <th class="num">${fmtHours(total('campaign'))}</th><th class="meter-col">${teamUsed}</th>
            ${unitCells({ edu: total('edu'), pc: total('pc'), internal: total('internal') }, 'th')}</tr>
        </tfoot>
      </table>
    </div>
    <p class="muted small table-note">Working hours are after bank holidays and time off. Productive is ${pct}% of that; the rest covers
      internal meetings, admin and non-productive time, so Internal hours aren't counted in "Used".</p>`;
}

function drawUpcoming(box, data) {
  const rows = focusCampaigns(upcomingFigures(data));
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
