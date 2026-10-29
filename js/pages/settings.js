import { renderPeople } from './people.js';
import { renderCapacitySettings } from './capacity-settings.js';
import { renderDesignSystem } from './design-system.js';

// Settings (Admin): People, Capacity and Design system tabs
const TABS = { people: 'People', capacity: 'Capacity', 'design-system': 'Design system' };

export function renderSettings(el, tab = 'people') {
  el.innerHTML = `
    <div class="page-header"><h1>Settings</h1></div>
    <nav class="tabs" aria-label="Settings sections">
      ${Object.entries(TABS).map(([key, label]) =>
        `<a class="tab ${key === tab ? 'active' : ''}" href="#/settings/${key}" ${key === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <div data-tab></div>`;
  const body = el.querySelector('[data-tab]');
  if (tab === 'capacity') renderCapacitySettings(body);
  else if (tab === 'design-system') renderDesignSystem(body);
  else renderPeople(body);
}
