import { supabase } from '../supabase.js';
import { state, loadPeople } from '../state.js';
import { esc, options, avatar, toast, errorMessage, confirmDialog, ROLES } from '../ui.js';

// Settings > People (Admin only): roles and deactivating people.
// Hours per day and "counts in capacity" live in Settings > Capacity.
export async function renderPeople(el) {
  el.innerHTML = `
    <p class="muted tab-intro">Everyone with a DSD email gets an account the first time they sign in, as a Team member.</p>
    <div data-list><p class="muted">Loading people…</p></div>`;

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
        <thead>
          <tr>
            <th>Person</th><th>Role</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${people.map(p => {
            const self = p.id === state.me.id;
            return `
              <tr data-id="${esc(p.id)}" class="${p.active ? '' : 'inactive'}">
                <td>
                  <span class="person">${avatar(p, 32)}
                    <span><strong>${esc(p.name)}</strong>${self ? ' <span class="muted">(you)</span>' : ''}<br>
                    <span class="muted small">${esc(p.email)}</span></span>
                  </span>
                </td>
                <td>
                  <select data-field="role" aria-label="Role for ${esc(p.name)}" ${self || !p.active ? 'disabled' : ''}>
                    ${options(ROLES, p.role)}
                  </select>
                </td>
                <td class="nowrap">
                  ${p.active ? '<span class="status status-in_progress">Active</span>' : '<span class="status status-on_hold">Deactivated</span>'}
                  ${self ? '' : `<button class="btn btn-small ${p.active ? 'btn-danger-outline' : ''}" type="button" data-toggle-active>
                    ${p.active ? 'Deactivate' : 'Reactivate'}</button>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  list.querySelectorAll('[data-field]').forEach(input => input.addEventListener('change', () => saveField(el, input)));
  list.querySelectorAll('[data-toggle-active]').forEach(button => button.addEventListener('click', () => toggleActive(el, button)));
}

async function saveField(el, input) {
  const id = input.closest('tr').dataset.id;
  const person = state.people.find(p => p.id === id);
  const field = input.dataset.field;
  const value = input.value;

  const { error } = await supabase.from('people').update({ [field]: value }).eq('id', id);
  if (error) {
    toast(errorMessage(error), 'error');
  } else {
    person[field] = value;
    toast(field === 'role' ? `${person.name} is now ${ROLES[value]}` : `Saved for ${person.name}`);
  }
  draw(el);
}

async function toggleActive(el, button) {
  const id = button.closest('tr').dataset.id;
  const person = state.people.find(p => p.id === id);
  const makeActive = !person.active;

  if (!makeActive) {
    const ok = await confirmDialog({
      title: `Deactivate ${person.name}?`,
      message: "They'll be signed out and won't be able to sign in. Everything they've done, including logged hours, is kept. You can reactivate them later.",
      confirmLabel: 'Deactivate',
      danger: true,
    });
    if (!ok) return;
  }

  const { error } = await supabase.rpc('set_person_active', { person_id: id, make_active: makeActive });
  if (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  person.active = makeActive;
  toast(makeActive ? `${person.name} can sign in again` : `${person.name} has been deactivated`);
  draw(el);
}
