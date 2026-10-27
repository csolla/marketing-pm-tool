// Small shared helpers for building pages

export const BUSINESS_UNITS = {
  education: 'Education',
  planning_center: 'Planning Center',
  shared: 'Shared',
};

export const CAMPAIGN_STATUSES = {
  planned: 'Planned',
  in_progress: 'In progress',
  done: 'Done',
  on_hold: 'On hold',
};

export const TASK_STATUSES = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

export const ROLES = {
  admin: 'Admin',
  member: 'Team member',
  director: 'Director',
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function options(map, selected) {
  return Object.entries(map)
    .map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
}

export function buTag(bu) {
  return `<span class="tag tag-${esc(bu)}">${esc(BUSINESS_UNITS[bu] || bu)}</span>`;
}

export function statusPill(status) {
  return `<span class="status status-${esc(status)}">${esc(CAMPAIGN_STATUSES[status] || status)}</span>`;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export function avatar(person, size = 28) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (person?.photo_url) {
    return `<img class="avatar" src="${esc(person.photo_url)}" alt="" style="${style}">`;
  }
  return `<span class="avatar avatar-initials" style="${style}" aria-hidden="true">${esc(initials(person?.name))}</span>`;
}

// Dates are stored as 'YYYY-MM-DD'; read them as local dates
function parseDate(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmtDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// Short form for cards and lists: "3 Nov", with the year only if it isn't this year
export function fmtShortDate(value) {
  const date = parseDate(value);
  if (!date) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-GB', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateRange(start, end) {
  if (!start && !end) return '—';
  if (start && end) return `${fmtDate(start)} – ${fmtDate(end)}`;
  return start ? `From ${fmtDate(start)}` : `Until ${fmtDate(end)}`;
}

export function fmtHours(value) {
  const n = Number(value) || 0;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} h`;
}

export function toast(message, type = 'success') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

// Turns Supabase errors into something readable
export function errorMessage(error) {
  const msg = error?.message || String(error);
  if (/row-level security|permission denied/i.test(msg)) return "You don't have permission to do that.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
  return msg;
}

// A dialog with a form. onSubmit(form) returns an error message to show,
// or nothing to close the dialog.
export function formDialog({ title, body, submitLabel = 'Save', onSubmit }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = `
    <form class="dialog-form" novalidate>
      <header class="dialog-header">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
      </header>
      <div class="dialog-body">${body}</div>
      <p class="form-error" hidden></p>
      <footer class="dialog-footer">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
      </footer>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const errorBox = dialog.querySelector('.form-error');
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    errorBox.hidden = true;
    submit.disabled = true;
    try {
      const problem = await onSubmit(form);
      if (problem) {
        errorBox.textContent = problem;
        errorBox.hidden = false;
      } else {
        dialog.close();
      }
    } catch (error) {
      errorBox.textContent = errorMessage(error);
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  dialog.showModal();
  form.querySelector('input, textarea, select')?.focus();
  return dialog;
}

// Resolves true if the person confirms
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    let confirmed = false;
    const dialog = formDialog({
      title,
      body: `<p>${esc(message)}</p>`,
      submitLabel: confirmLabel,
      onSubmit: () => { confirmed = true; },
    });
    if (danger) dialog.querySelector('[type=submit]').classList.add('btn-danger');
    dialog.addEventListener('close', () => resolve(confirmed));
  });
}
