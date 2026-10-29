import { supabase } from '../supabase.js';
import { ALLOWED_EMAIL_DOMAIN } from '../config.js';
import { esc, errorMessage } from '../ui.js';

const LAST_EMAIL_KEY = 'mpm-last-email';
const RESEND_SECONDS = 60;

const isDsdEmail = email => email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);

function savedEmail() {
  try { return localStorage.getItem(LAST_EMAIL_KEY) || ''; } catch { return ''; }
}

// Letters you'd need to change to turn one word into the other
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// "csolla" or "csolla@digitalsmiledesing.com" -> "csolla@digitalsmiledesign.com"
function suggestion(email) {
  const [name, domain] = email.trim().toLowerCase().split('@');
  if (!name) return null;
  if (domain === undefined) return `${name}@${ALLOWED_EMAIL_DOMAIN}`;
  if (domain && domain !== ALLOWED_EMAIL_DOMAIN && distance(domain, ALLOWED_EMAIL_DOMAIN) <= 3) {
    return `${name}@${ALLOWED_EMAIL_DOMAIN}`;
  }
  return null;
}

async function sendLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (!error) return null;
  // The database refuses non-DSD sign-ups; Supabase reports that as a generic error
  if (/database error/i.test(error.message)) return `Only @${ALLOWED_EMAIL_DOMAIN} email addresses can sign in.`;
  if (/security purposes/i.test(error.message)) return 'A link was just sent to this address. Wait a minute before asking for another.';
  if (/rate limit/i.test(error.message)) return 'The app has sent too many sign-in emails in the last hour. Try again later, or use the last link you received.';
  return errorMessage(error);
}

export function renderLogin(el, { error } = {}) {
  el.innerHTML = `
    <div class="login">
      <aside class="login-welcome">
        <div class="brand brand-large brand-inverse">
          <span class="brand-mark" aria-hidden="true">M</span>
          <span class="brand-name">Marketing PM</span>
        </div>
        <h2>Where DSD Marketing plans its work and tracks its time.</h2>
        <ul class="welcome-points">
          <li><strong>Campaigns and tasks</strong><span>Boards, lists and everything assigned to you in one place.</span></li>
          <li><strong>Time logging</strong><span>A weekly timesheet and a timer on any task.</span></li>
          <li><strong>Capacity and budgets</strong><span>Hours for Education and Planning Center, kept within budget.</span></li>
          <li><strong>Dashboards</strong><span>Clear figures for the directors, ready to present.</span></li>
        </ul>
      </aside>
      <div class="login-card" data-card></div>
    </div>`;
  showForm(el.querySelector('[data-card]'), { error, email: savedEmail() });
}

function showForm(card, { error = null, email = '' } = {}) {
  card.innerHTML = `
    <form novalidate>
      <div class="brand brand-large login-card-brand">
        <span class="brand-mark" aria-hidden="true">M</span>
        <span class="brand-name">Marketing PM</span>
      </div>
      <h1>Sign in</h1>
      <p class="muted login-lead">Enter your DSD email and we'll send you a sign-in link. No password needed.</p>
      <label class="field">
        <span>Email</span>
        <input type="email" name="email" autocomplete="email" placeholder="name@${esc(ALLOWED_EMAIL_DOMAIN)}" value="${esc(email)}" required>
      </label>
      <p class="email-suggestion" data-suggestion hidden></p>
      <button class="btn btn-primary btn-block" type="submit">Send sign-in link</button>
      <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error || '')}</p>
    </form>`;

  const form = card.querySelector('form');
  const input = form.elements.email;
  const errorBox = form.querySelector('.form-error');
  const hint = form.querySelector('[data-suggestion]');
  const submit = form.querySelector('[type=submit]');
  const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };

  // Offer the right address when the domain looks mistyped or is missing
  const updateHint = () => {
    const better = input.value.includes('@') || input.value.length > 2 ? suggestion(input.value) : null;
    hint.hidden = !better || better === input.value.trim().toLowerCase();
    if (!hint.hidden) {
      hint.innerHTML = `Did you mean <button type="button" class="link-btn">${esc(better)}</button>?`;
      hint.querySelector('button').addEventListener('click', () => {
        input.value = better;
        hint.hidden = true;
        input.focus();
      });
    }
  };
  input.addEventListener('input', () => { showError(''); updateHint(); });
  input.addEventListener('blur', updateHint);
  input.focus();
  if (email) input.select();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = input.value.trim().toLowerCase();
    if (!value || !value.includes('@')) {
      updateHint();
      return showError('Enter your full DSD email address.');
    }
    if (!isDsdEmail(value)) {
      updateHint();
      return showError(`Only @${ALLOWED_EMAIL_DOMAIN} email addresses can sign in.`);
    }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const problem = await sendLink(value);
    submit.disabled = false;
    submit.textContent = 'Send sign-in link';
    if (problem) return showError(problem);
    try { localStorage.setItem(LAST_EMAIL_KEY, value); } catch { /* not saved; fine */ }
    showSent(card, value);
  });
}

// After sending: what to do next, with Resend unlocked after a minute
function showSent(card, email) {
  card.innerHTML = `
    <div class="login-sent" aria-live="polite">
      <div class="sent-icon" aria-hidden="true">✉</div>
      <h1>Check your inbox</h1>
      <p>We sent a sign-in link to <strong>${esc(email)}</strong>. Open it on this device to sign in. You can close this tab.</p>
      <ul class="sent-tips muted small">
        <li>Not there after a minute? Check your spam or junk folder.</li>
        <li>Each link works once and expires after a while; ask for a new one if needed.</li>
      </ul>
      <button class="btn btn-block" type="button" data-resend disabled></button>
      <button class="btn btn-ghost btn-block" type="button" data-change>Use a different email</button>
      <p class="form-error" role="alert" hidden></p>
    </div>`;

  const resend = card.querySelector('[data-resend]');
  const errorBox = card.querySelector('.form-error');
  let left = RESEND_SECONDS;
  const tick = () => {
    if (!card.isConnected || !card.contains(resend)) return clearInterval(timer);
    if (left > 0) {
      resend.disabled = true;
      resend.textContent = `Resend link in ${left}s`;
      left -= 1;
    } else {
      resend.disabled = false;
      resend.textContent = 'Resend link';
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, 1000);
  tick();

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    resend.textContent = 'Sending…';
    const problem = await sendLink(email);
    errorBox.textContent = problem || '';
    errorBox.hidden = !problem;
    if (!problem) showSent(card, email);
    else { resend.disabled = false; resend.textContent = 'Resend link'; }
  });
  card.querySelector('[data-change]').addEventListener('click', () => {
    clearInterval(timer);
    showForm(card, { email: '' });
  });
}
