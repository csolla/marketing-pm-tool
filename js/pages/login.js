import { supabase } from '../supabase.js';
import { ALLOWED_EMAIL_DOMAIN } from '../config.js';
import { esc, errorMessage } from '../ui.js';

const isDsdEmail = email => email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);

export function renderLogin(el, { error } = {}) {
  el.innerHTML = `
    <div class="login">
      <form class="login-card" novalidate>
        <div class="brand brand-large">
          <span class="brand-mark" aria-hidden="true">M</span>
          <span class="brand-name">Marketing PM</span>
        </div>
        <h1>Sign in</h1>
        <p class="muted">Enter your DSD email and we'll send you a sign-in link. No password needed.</p>
        <label class="field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" placeholder="name@${esc(ALLOWED_EMAIL_DOMAIN)}" required>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Send sign-in link</button>
        <p class="form-error" ${error ? '' : 'hidden'}>${esc(error || '')}</p>
        <p class="form-success" hidden></p>
      </form>
    </div>`;

  const form = el.querySelector('form');
  const input = form.querySelector('input');
  const errorBox = form.querySelector('.form-error');
  const successBox = form.querySelector('.form-success');
  const submit = form.querySelector('button');
  input.focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = input.value.trim();
    errorBox.hidden = true;
    successBox.hidden = true;

    if (!email || !email.includes('@')) {
      errorBox.textContent = 'Enter your email address.';
      errorBox.hidden = false;
      return;
    }
    if (!isDsdEmail(email)) {
      errorBox.textContent = `Only @${ALLOWED_EMAIL_DOMAIN} email addresses can sign in.`;
      errorBox.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending…';
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    submit.disabled = false;
    submit.textContent = 'Send sign-in link';

    if (sendError) {
      // The database refuses non-DSD sign-ups; Supabase reports that as a generic error
      errorBox.textContent = /database error/i.test(sendError.message)
        ? `Only @${ALLOWED_EMAIL_DOMAIN} email addresses can sign in.`
        : /rate limit|security purposes/i.test(sendError.message)
          ? 'Too many sign-in emails were sent. Wait a minute and try again.'
          : errorMessage(sendError);
      errorBox.hidden = false;
      return;
    }
    successBox.textContent = `Check your inbox: we sent a sign-in link to ${email}. You can close this tab.`;
    successBox.hidden = false;
  });
}
