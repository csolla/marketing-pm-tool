import { supabase, inviteClient } from '../supabase.js';
import { state, loadPeople } from '../state.js';
import { ALLOWED_EMAIL_DOMAIN } from '../config.js';
import { esc, options, avatar, toast, errorMessage, confirmDialog, formDialog, ROLES } from '../ui.js';

// Settings > People (Admin): everything about each person in one place:
// role, capacity (hours per day, working days, calendar, counts in capacity)
// and active/deactivated. Team-wide rules live in Settings > Capacity.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CALENDARS = { Madrid: 'Madrid', England: 'England' };
const ROLE_HELP = {
  admin: 'Everything, including Settings, budgets and editing anyone\'s time.',
  member: 'Campaigns, tasks, comments and their own time and time off. Can view Dashboards.',
  director: 'Dashboards only. Can\'t see or change campaigns, tasks or time.',
};
// What someone gains or loses when their role changes
const ROLE_CHANGE = {
  director: 'will only see Dashboards. They won\'t see campaigns, tasks or their time, and can\'t log hours.',
  member: 'will be able to work on campaigns and tasks and log their own time, but not open Settings.',
  admin: 'will have full control, including Settings, budgets, deleting campaigns and editing anyone\'s time.',
};

const isDefault = p => Number(p.hours_per_day) === 8 && (p.working_days || [1, 2, 3, 4, 5]).join() === '1,2,3,4,5'
  && p.holiday_calendar === 'Madrid';
// New team members still on the starting settings
const needsSetup = p => p.active && p.role === 'member' && isDefault(p)
  && Date.now() - new Date(p.created_at) < 60 * 86400000;

function daysText(days) {
  const list = (days || [1, 2, 3, 4, 5]).map(Number).sort();
  const consecutive = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  return consecutive && list.length > 2 ? `${DAYS[list[0] - 1]}–${DAYS[list[list.length - 1] - 1]}` : list.map(d => DAYS[d - 1]).join(', ');
}

function capacityText(p) {
  if (!p.counts_in_capacity) return '<span class="muted">Not counted in capacity</span>';
  return `${Number(p.hours_per_day)} h/day · ${esc(daysText(p.working_days))} · ${esc(p.holiday_calendar)}`;
}

export async function renderPeople(el) {
  el.innerHTML = `
    <div class="people-intro">
      <p class="muted">Everyone with a DSD email gets an account the first time they sign in, as a Team member.
        Use <strong>Invite</strong> to send someone their first sign-in link.</p>
      <button class="btn btn-primary" type="button" data-invite>Invite</button>
    </div>
    <div class="role-guide">
      ${Object.entries(ROLE_HELP).map(([role, help]) => `<div><strong>${esc(ROLES[role])}</strong><span class="muted small">${esc(help)}</span></div>`).join('')}
    </div>
    <div data-list><p class="muted">Loading people…</p></div>`;

  el.querySelector('[data-invite]').addEventListener('click', () => invite(el));
  try {
    await loadPeople();
  } catch (error) {
    el.querySelector('[data-list]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  draw(el);
}

function draw(el) {
  const people = [...state.people].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  const list = el.querySelector('[data-list]');

  list.innerHTML = `
    <div class="table-wrap">
      <table class="table people-table">
        <thead><tr><th>Person</th><th>Role</th><th>Capacity</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${people.map(p => {
            const self = p.id === state.me.id;
            const directorCounted = p.role === 'director' && p.counts_in_capacity;
            return `
              <tr data-id="${esc(p.id)}" class="${p.active ? '' : 'inactive'}">
                <td>
                  <span class="person">${avatar(p, 32)}
                    <span><strong>${esc(p.name)}</strong>${self ? ' <span class="muted">(you)</span>' : ''}<br>
                    <span class="muted small">${esc(p.email)}</span></span>
                  </span>
                </td>
                <td>${esc(ROLES[p.role])}</td>
                <td>
                  ${capacityText(p)}
                  ${needsSetup(p) ? '<span class="setup-flag">Needs setup</span>' : ''}
                  ${directorCounted ? '<span class="setup-flag" title="Directors usually don\'t count in team capacity">Director counted in capacity?</span>' : ''}
                </td>
                <td>${p.active ? '<span class="status status-in_progress">Active</span>' : '<span class="status status-on_hold">Deactivated</span>'}</td>
                <td class="nowrap row-actions">
                  ${p.active ? '<button class="btn btn-small" type="button" data-edit>Edit</button>' : ''}
                  ${self ? '' : `<button class="btn btn-small ${p.active ? 'btn-ghost' : ''}" type="button" data-toggle-active>
                    ${p.active ? 'Deactivate' : 'Reactivate'}</button>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  list.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () =>
    editPerson(el, state.people.find(p => p.id === button.closest('tr').dataset.id))));
  list.querySelectorAll('[data-toggle-active]').forEach(button => button.addEventListener('click', () => toggleActive(el, button)));
}

// Role and capacity for one person, in one dialog
function editPerson(el, person) {
  const self = person.id === state.me.id;
  const days = (person.working_days || [1, 2, 3, 4, 5]).map(Number);
  const dialog = formDialog({
    title: `Edit ${person.name}`,
    submitLabel: 'Save',
    body: `
      <label class="field"><span>Role</span>
        <select name="role" ${self ? 'disabled' : ''}>${options(ROLES, person.role)}</select></label>
      <p class="muted small form-note" data-role-help>${esc(ROLE_HELP[person.role])}</p>
      <div class="field-row">
        <label class="field"><span>Hours per working day</span>
          <input type="number" name="hours_per_day" min="0" max="24" step="0.5" value="${esc(person.hours_per_day)}"></label>
        <label class="field"><span>Holiday calendar</span>
          <select name="holiday_calendar">${options(CALENDARS, person.holiday_calendar)}</select></label>
      </div>
      <div class="field"><span>Working days</span>
        <span class="day-picks">${DAYS.map((d, i) => `<label class="day-pick" title="${d}"><input type="checkbox" name="day" value="${i + 1}" ${days.includes(i + 1) ? 'checked' : ''}><span>${d[0]}</span></label>`).join('')}</span>
      </div>
      <label class="toggle"><input type="checkbox" name="counts_in_capacity" ${person.counts_in_capacity ? 'checked' : ''}>
        Counts in team capacity (and budgets)</label>`,
    onSubmit: async form => {
      const values = {
        hours_per_day: Number(form.elements.hours_per_day.value),
        holiday_calendar: form.elements.holiday_calendar.value,
        working_days: [...form.querySelectorAll('[name=day]:checked')].map(c => Number(c.value)),
        counts_in_capacity: form.elements.counts_in_capacity.checked,
      };
      if (!Number.isFinite(values.hours_per_day) || values.hours_per_day < 0 || values.hours_per_day > 24) {
        return 'Hours per day must be between 0 and 24.';
      }
      if (!values.working_days.length) return 'Choose at least one working day.';
      const role = form.elements.role.value;
      if (!self && role !== person.role) {
        const ok = await confirmDialog({
          title: `Make ${person.name} ${ROLES[role]}?`,
          message: `${person.name} ${ROLE_CHANGE[role]}`,
          confirmLabel: `Make ${ROLES[role]}`,
          danger: role === 'director',
        });
        if (!ok) return 'Role not changed. Pick the role again or cancel.';
        values.role = role;
      }
      const { error } = await supabase.from('people').update(values).eq('id', person.id);
      if (error) return errorMessage(error);
      Object.assign(person, values);
      toast(`Saved for ${person.name}`);
      draw(el);
    },
  });
  // Explain the selected role as it changes
  dialog.querySelector('[name=role]').addEventListener('change', event => {
    dialog.querySelector('[data-role-help]').textContent = ROLE_HELP[event.target.value];
  });
}

async function toggleActive(el, button) {
  const id = button.closest('tr').dataset.id;
  const person = state.people.find(p => p.id === id);
  const makeActive = !person.active;

  const ok = await confirmDialog(makeActive
    ? {
      title: `Reactivate ${person.name}?`,
      message: `${person.name} will be able to sign in again, as a ${ROLES[person.role]}.`,
      confirmLabel: 'Reactivate',
    }
    : {
      title: `Deactivate ${person.name}?`,
      message: "They'll be signed out and won't be able to sign in. Everything they've done, including logged hours, is kept. Reassign their open tasks. You can reactivate them later.",
      confirmLabel: 'Deactivate',
      danger: true,
    });
  if (!ok) return;

  const { error } = await supabase.rpc('set_person_active', { person_id: id, make_active: makeActive });
  if (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  person.active = makeActive;
  toast(makeActive ? `${person.name} can sign in again` : `${person.name} has been deactivated`);
  draw(el);
}

// Send a DSD address its first sign-in link; the account appears straight away
function invite(el) {
  formDialog({
    title: 'Invite someone',
    submitLabel: 'Send invite',
    body: `
      <label class="field"><span>Their DSD email</span>
        <input type="email" name="email" required placeholder="name@${esc(ALLOWED_EMAIL_DOMAIN)}"></label>
      <p class="muted small">They'll get an email with a sign-in link and start as a Team member. Change their role and capacity here afterwards.</p>`,
    onSubmit: async form => {
      const email = form.elements.email.value.trim().toLowerCase();
      if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) return `Only @${ALLOWED_EMAIL_DOMAIN} addresses can be invited.`;
      if (state.people.some(p => p.email === email)) return 'That person already has an account.';
      const { error } = await inviteClient.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname, shouldCreateUser: true },
      });
      if (error) {
        if (/rate limit/i.test(error.message)) return 'Too many sign-in emails were sent this hour. Try again later.';
        if (/not authorized/i.test(error.message)) {
          return "Supabase's built-in email can't send to this address yet. Set up custom email (Brevo) first, or ask them to sign in themselves.";
        }
        return errorMessage(error);
      }
      toast(`Invite sent to ${email}`);
      await loadPeople().catch(() => {});
      draw(el);
    },
  });
}
