import { supabase } from './supabase.js';
import { state, loadMe, loadPeople, isDirector } from './state.js';
import { esc, avatar, ROLES, errorMessage } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderCampaigns } from './pages/campaigns.js';
import { renderCampaign } from './pages/campaign.js';
import { renderPeople } from './pages/people.js';
import { renderProfile } from './pages/profile.js';
import { renderPlaceholder } from './pages/placeholder.js';

const ALL = ['admin', 'member', 'director'];
const WORK = ['admin', 'member'];

// Each page, who can open it, and the nav item it belongs to
const ROUTES = [
  { path: /^\/my-tasks$/, roles: WORK, nav: 'my-tasks', render: el => renderPlaceholder(el, 'my-tasks') },
  { path: /^\/campaigns$/, roles: WORK, nav: 'campaigns', render: renderCampaigns },
  { path: /^\/campaigns\/([0-9a-f-]{36})$/, roles: WORK, nav: 'campaigns', render: (el, id) => renderCampaign(el, id) },
  { path: /^\/my-time$/, roles: WORK, nav: 'my-time', render: el => renderPlaceholder(el, 'my-time') },
  { path: /^\/dashboards$/, roles: ['admin', 'director'], nav: 'dashboards', render: el => renderPlaceholder(el, 'dashboards') },
  { path: /^\/people$/, roles: ['admin'], nav: 'settings', render: renderPeople },
  { path: /^\/profile$/, roles: ALL, nav: null, render: renderProfile },
];

const NAV = [
  { key: 'my-tasks', label: 'My tasks', href: '#/my-tasks', roles: WORK },
  { key: 'campaigns', label: 'Campaigns', href: '#/campaigns', roles: WORK },
  { key: 'my-time', label: 'My time', href: '#/my-time', roles: WORK },
  { key: 'dashboards', label: 'Dashboards', href: '#/dashboards', roles: ['admin', 'director'] },
  { key: 'settings', label: 'Settings', href: '#/people', roles: ['admin'] },
];

// Directors land on Dashboards; everyone else on Campaigns for now
// (My tasks becomes the home page in milestone 2)
function homePath() {
  return isDirector() ? '/dashboards' : '/campaigns';
}

const app = document.getElementById('app');
let currentUserId = null;

// ---------------------------------------------------------------------------
// Sign-in state
// ---------------------------------------------------------------------------

// A failed or expired sign-in link comes back as #error=...&error_description=...
function readLinkError() {
  const hash = window.location.hash;
  if (!hash.includes('error_description=')) return null;
  const params = new URLSearchParams(hash.slice(1));
  history.replaceState(null, '', window.location.pathname);
  const code = params.get('error_code');
  if (code === 'otp_expired') return 'That sign-in link has expired or was already used. Ask for a new one below.';
  return params.get('error_description') || 'That sign-in link did not work. Ask for a new one below.';
}

const linkError = readLinkError();

supabase.auth.onAuthStateChange((event, session) => {
  // Run outside the callback so Supabase calls inside don't wait on each other
  setTimeout(() => handleAuth(session), 0);
});

async function handleAuth(session) {
  const userId = session?.user?.id || null;
  if (userId === currentUserId && (userId || app.querySelector('.login'))) return;
  currentUserId = userId;

  if (!userId) {
    state.me = null;
    state.people = [];
    renderLogin(app, { error: linkError });
    return;
  }

  try {
    const me = await loadMe(userId);
    if (!me) {
      currentUserId = null;
      await supabase.auth.signOut();
      renderLogin(app, { error: 'Your account is not active. Ask Carlota if you need access.' });
      return;
    }
    await loadPeople();
  } catch (error) {
    app.innerHTML = `<div class="splash">Could not load the app: ${esc(errorMessage(error))}</div>`;
    return;
  }

  renderShell();
  if (!window.location.hash.startsWith('#/')) {
    history.replaceState(null, '', `${window.location.pathname}#${homePath()}`);
  }
  route();
}

// ---------------------------------------------------------------------------
// Shell: top bar, navigation and the page area
// ---------------------------------------------------------------------------

function renderShell() {
  const role = state.me.role;
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#${homePath()}">
        <span class="brand-mark" aria-hidden="true">M</span>
        <span class="brand-name">Marketing PM</span>
      </a>
      <nav class="nav" aria-label="Main">
        ${NAV.filter(item => item.roles.includes(role)).map(item =>
          `<a class="nav-link" data-nav="${item.key}" href="${item.href}">${esc(item.label)}</a>`).join('')}
      </nav>
      <div class="user-menu">
        <button class="user-button" type="button" aria-haspopup="true" aria-expanded="false" title="${esc(state.me.name)}">
          ${avatar(state.me, 32)}
        </button>
        <div class="menu" hidden>
          <div class="menu-head">
            <strong>${esc(state.me.name)}</strong>
            <span>${esc(ROLES[role])}</span>
          </div>
          <a class="menu-item" href="#/profile">Profile</a>
          <button class="menu-item" type="button" data-sign-out>Sign out</button>
        </div>
      </div>
    </header>
    <main class="page" id="page"></main>`;

  const button = app.querySelector('.user-button');
  const menu = app.querySelector('.menu');
  const setOpen = open => { menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  button.addEventListener('click', event => { event.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) setOpen(false);
  });
  menu.querySelector('[data-sign-out]').addEventListener('click', () => supabase.auth.signOut());
}

// The Profile page fires this after a name or photo change
window.addEventListener('me-updated', () => {
  const button = app.querySelector('.user-button');
  if (!button || !state.me) return;
  button.innerHTML = avatar(state.me, 32);
  button.title = state.me.name;
  app.querySelector('.menu-head strong').textContent = state.me.name;
});

function route() {
  if (!state.me) return;
  const path = window.location.hash.replace(/^#/, '');
  const match = ROUTES.map(r => ({ r, m: path.match(r.path) })).find(x => x.m);

  if (!match || !match.r.roles.includes(state.me.role)) {
    window.location.hash = homePath();
    return;
  }

  app.querySelectorAll('.nav-link').forEach(link =>
    link.classList.toggle('active', link.dataset.nav === match.r.nav));
  app.querySelector('.menu')?.setAttribute('hidden', '');

  const page = document.getElementById('page');
  page.innerHTML = '';
  window.scrollTo(0, 0);
  match.r.render(page, ...match.m.slice(1));
}

window.addEventListener('hashchange', route);
