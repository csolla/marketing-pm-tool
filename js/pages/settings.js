import { renderPeople } from './people.js';
import { renderCapacitySettings } from './capacity-settings.js';

// Capacity (Admin): people, team rules, monthly budgets, holidays & time off
export const CAPACITY_SECTIONS = {
  people: 'People',
  rules: 'Team rules',
  budgets: 'Monthly budgets',
  calendar: 'Holidays & time off',
};

export function renderCapacityPage(el, section = 'people') {
  el.innerHTML = `
    <div class="page-header"><h1>Capacity</h1></div>
    <nav class="tabs" aria-label="Capacity sections">
      ${Object.entries(CAPACITY_SECTIONS).map(([key, label]) =>
        `<a class="tab ${key === section ? 'active' : ''}" href="#/capacity/${key}" ${key === section ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <div data-tab></div>`;
  const body = el.querySelector('[data-tab]');
  if (section === 'people') renderPeople(body);
  else renderCapacitySettings(body, section);
}
