import { supabase } from '../supabase.js';
import { state, loadPeople } from '../state.js';
import { esc, options, avatar, toast, errorMessage, confirmDialog, ROLES } from '../ui.js';

// Settings > People (Admin only)
export async function renderPeople(el) {
  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1>People</h1>
        <p class="muted">Everyone with a DSD email gets an account the first time they sign in, as a Team member.</p>
      </div>
    </div>
    <form class="card split-card" data-split novalidate>
      <div>
        <h2>Shared campaigns split</h2>
        <p class="muted small">How hours logged on Shared campaigns divide between the two business units.
          Changes apply to hours logged from now on; past entries keep their split.</p>
      </div>
      <div class="split-inputs">
        <label class="inline-field">Education
          <input type="number" name="education" min="0" max="100" step="1" required aria-label="Education percentage"> %</label>
        <span class="muted">Planning Center <strong data-pc>…</strong></span>
        <button class="btn btn-primary btn-small" type="submit">Save</button>
      </div>
    </form>
    <div data-list><p class="muted">Loading people…</p></div>`;

  setUpSplit(el);

  try {
    await loadPeople();
  } catch (error) {
    el.querySelector('[data-list]').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  draw(el);
}

async function setUpSplit(el) {
  const form = el.querySelector('[data-split]');
  const input = form.elements.education;
  const showPc = () => {
    const edu = Number(input.value);
    form.querySelector('[data-pc]').textContent = input.value !== '' && edu >= 0 && edu <= 100 ? `${100 - edu} %` : '–';
  };
  input.addEventListener('input', showPc);

  const { data, error } = await supabase.from('team_settings').select('shared_split_education').maybeSingle();
  if (error || !data) {
    form.querySelector('.split-inputs').innerHTML = `<p class="form-error">${esc(errorMessage(error || 'Settings not found'))}</p>`;
    return;
  }
  input.value = data.shared_split_education;
  showPc();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const edu = Number(input.value);
    if (input.value === '' || !Number.isInteger(edu) || edu < 0 || edu > 100) {
      toast('Use a whole number from 0 to 100.', 'error');
      return;
    }
    const { error: saveError } = await supabase.from('team_settings').update({ shared_split_education: edu }).eq('id', true);
    if (saveError) toast(errorMessage(saveError), 'error');
    else toast(`Shared split is now ${edu} / ${100 - edu}`);
  });
}

function draw(el) {
  const people = [...state.people].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  const list = el.querySelector('[data-list]');

  list.innerHTML = `
    <div class="table-wrap">
      <table class="table people-table">
        <thead>
          <tr>
            <th>Person</th><th>Role</th><th>Hours per day</th><th>Counts in capacity</th><th>Status</th>
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
                <td>
                  <input class="hours-input" type="number" data-field="hours_per_day" min="0" max="24" step="0.5"
                    value="${esc(p.hours_per_day)}" aria-label="Hours per day for ${esc(p.name)}" ${p.active ? '' : 'disabled'}>
                </td>
                <td>
                  <input type="checkbox" data-field="counts_in_capacity" ${p.counts_in_capacity ? 'checked' : ''}
                    aria-label="${esc(p.name)} counts in capacity" ${p.active ? '' : 'disabled'}>
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
  let value;
  if (field === 'counts_in_capacity') value = input.checked;
  else if (field === 'hours_per_day') {
    value = Number(input.value);
    if (input.value === '' || !Number.isFinite(value) || value < 0 || value > 24) {
      toast('Hours per day must be between 0 and 24.', 'error');
      input.value = person.hours_per_day;
      return;
    }
  } else value = input.value;

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
