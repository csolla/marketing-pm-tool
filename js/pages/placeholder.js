import { esc } from '../ui.js';

const PAGES = {
  'my-time': {
    title: 'My time',
    text: 'Your weekly timesheet and timer. Coming soon.',
  },
  dashboards: {
    title: 'Dashboards',
    text: 'Hours against budget for Education and Planning Center, trends, campaigns and team capacity. Coming soon.',
  },
};

export function renderPlaceholder(el, key) {
  const page = PAGES[key];
  el.innerHTML = `
    <div class="page-header"><h1>${esc(page.title)}</h1></div>
    <div class="empty-state">
      <p>${esc(page.text)}</p>
    </div>`;
}
