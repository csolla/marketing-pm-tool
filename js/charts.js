import { esc, fmtHours } from './ui.js';

// Charts for Dashboards, drawn as plain HTML/SVG. Colours come from CSS
// tokens (--series-edu, --series-pc, --status-*) so light and dark mode each
// use their own validated steps.

const pct = (used, budget) => (budget ? Math.round(used / budget * 100) : null);

// Budget status: green under 80%, amber from 80%, red at 100% or more.
// Always shown with an icon and a label, never colour alone.
export function budgetStatus(used, budget) {
  const p = pct(used, budget);
  if (p == null) return { key: 'none', label: 'No budget set', icon: '–' };
  if (p >= 100) return { key: 'critical', label: 'Budget reached', icon: '!' };
  if (p >= 80) return { key: 'warning', label: 'Over 80%', icon: '▲' };
  return { key: 'good', label: 'Within budget', icon: '✓' };
}

// One horizontal bar per unit: hours used against the budget.
// units: [{ key, label, used, budget }]
export function budgetBars(units, selected) {
  return units.map(unit => {
    const status = budgetStatus(unit.used, unit.budget);
    const p = pct(unit.used, unit.budget);
    const width = p == null ? 0 : Math.min(100, p);
    return `
      <button type="button" class="budget-row ${selected === unit.key ? 'is-selected' : ''}" data-unit="${unit.key}"
        aria-pressed="${selected === unit.key}" title="Show ${esc(unit.label)} campaigns below">
        <span class="budget-row-head">
          <span class="budget-unit"><span class="swatch swatch-${unit.key}" aria-hidden="true"></span>${esc(unit.label)}</span>
          <span class="budget-figures"><strong>${fmtHours(unit.used)}</strong>${unit.budget ? ` of ${fmtHours(unit.budget)}` : ''}${p == null ? '' : ` · ${p}%`}</span>
        </span>
        <span class="meter meter-${status.key}" aria-hidden="true">
          ${unit.budget ? `<span class="meter-fill" style="width:${width}%"></span>` : ''}
        </span>
        <span class="status-chip status-${status.key}"><span aria-hidden="true">${status.icon}</span> ${esc(status.label)}${
          p != null && p > 100 ? ` · ${fmtHours(unit.used - unit.budget)} over` : ''}</span>
      </button>`;
  }).join('');
}

// Round the axis maximum up to a clean number and pick 4–5 ticks
function niceScale(max) {
  if (max <= 0) return { top: 10, ticks: [0, 5, 10] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= rough);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  return { top, ticks };
}

// Column with a 4px rounded top, square at the baseline
function columnPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const compact = n => (n >= 1000 ? `${parseFloat((n / 1000).toFixed(1))}K` : String(parseFloat(n.toFixed(1))));

// Hours per unit per month as paired columns, with each unit's budget as a
// dashed line. months: [{ month, label, edu, pc, internal, eduBudget, pcBudget, highlight }]
export function trendChart(container, months) {
  const W = 720;
  const H = 260;
  const m = { l: 40, r: 12, t: 14, b: 30 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const values = months.flatMap(d => [d.edu, d.pc, d.eduBudget || 0, d.pcBudget || 0]);
  const { top, ticks } = niceScale(Math.max(0, ...values));
  const y = v => m.t + plotH - (v / top) * plotH;
  const band = plotW / months.length;
  const barW = Math.max(4, Math.min(24, (band * 0.7 - 2) / 2));
  const center = i => m.l + band * i + band / 2;

  // Each month's budget as a short level line across that month's columns
  const budgetLine = field => months.map((d, i) => (d[field] == null ? '' : `<line
    x1="${m.l + band * i + band * 0.12}" x2="${m.l + band * (i + 1) - band * 0.12}" y1="${y(d[field])}" y2="${y(d[field])}" />`)).join('');

  container.innerHTML = `
    <div class="chart-legend" aria-hidden="true">
      <span><span class="swatch swatch-education"></span>Education</span>
      <span><span class="swatch swatch-planning_center"></span>Planning Center</span>
      <span><span class="line-key line-key-education"></span>Education budget</span>
      <span><span class="line-key line-key-planning_center"></span>Planning Center budget</span>
    </div>
    <div class="chart-wrap">
      <svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Hours per business unit per month, with monthly budgets. Use Show as table for the numbers.">
        <g class="grid">
          ${ticks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" />`).join('')}
        </g>
        <g class="axis-labels">
          ${ticks.map(t => `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
          ${months.map((d, i) => `<text x="${center(i)}" y="${H - 10}" text-anchor="middle" class="${d.highlight ? 'is-highlight' : ''}">${esc(d.label)}</text>`).join('')}
        </g>
        <g class="bars-edu">
          ${months.map((d, i) => `<path d="${columnPath(center(i) - barW - 1, y(d.edu), barW, plotH + m.t - y(d.edu))}" />`).join('')}
        </g>
        <g class="bars-pc">
          ${months.map((d, i) => `<path d="${columnPath(center(i) + 1, y(d.pc), barW, plotH + m.t - y(d.pc))}" />`).join('')}
        </g>
        <g class="budget-line budget-line-edu">${budgetLine('eduBudget')}</g>
        <g class="budget-line budget-line-pc">${budgetLine('pcBudget')}</g>
        <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + plotH}" y2="${m.t + plotH}" />
        <g class="hover-bands">
          ${months.map((d, i) => `<rect x="${m.l + band * i}" y="${m.t}" width="${band}" height="${plotH}" data-i="${i}" tabindex="0"
            aria-label="${esc(d.label)}: Education ${fmtHours(d.edu)}, Planning Center ${fmtHours(d.pc)}" />`).join('')}
        </g>
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>`;

  const svg = container.querySelector('svg');
  const tooltip = container.querySelector('.chart-tooltip');
  const show = rect => {
    const d = months[Number(rect.dataset.i)];
    const budgetText = b => (b == null ? 'no budget' : `budget ${fmtHours(b)}`);
    tooltip.innerHTML = `
      <strong>${esc(d.fullLabel || d.label)}</strong>
      <span><span class="swatch swatch-education"></span>Education ${fmtHours(d.edu)} <span class="muted">(${budgetText(d.eduBudget)})</span></span>
      <span><span class="swatch swatch-planning_center"></span>Planning Center ${fmtHours(d.pc)} <span class="muted">(${budgetText(d.pcBudget)})</span></span>
      <span class="muted">Internal ${fmtHours(d.internal)}</span>`;
    tooltip.hidden = false;
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    const x = (Number(rect.getAttribute('x')) + band / 2) * scale;
    const left = Math.min(Math.max(x - tooltip.offsetWidth / 2, 0), box.width - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${m.t * scale}px`;
    svg.querySelectorAll('.hover-bands rect').forEach(r => r.classList.toggle('is-active', r === rect));
  };
  const hide = () => {
    tooltip.hidden = true;
    svg.querySelectorAll('.hover-bands rect').forEach(r => r.classList.remove('is-active'));
  };
  svg.querySelectorAll('.hover-bands rect').forEach(rect => {
    rect.addEventListener('mouseenter', () => show(rect));
    rect.addEventListener('focus', () => show(rect));
    rect.addEventListener('blur', hide);
  });
  svg.addEventListener('mouseleave', hide);
}

// The same numbers as a table (for screen readers, print, and exact values)
export function trendTable(months) {
  const b = v => (v == null ? '—' : fmtHours(v));
  return `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Month</th><th class="num">Education</th><th class="num">Education budget</th>
          <th class="num">Planning Center</th><th class="num">Planning Center budget</th><th class="num">Internal</th></tr></thead>
        <tbody>
          ${months.map(d => `<tr><td>${esc(d.fullLabel || d.label)}</td><td class="num">${fmtHours(d.edu)}</td><td class="num">${b(d.eduBudget)}</td>
            <td class="num">${fmtHours(d.pc)}</td><td class="num">${b(d.pcBudget)}</td><td class="num">${fmtHours(d.internal)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
