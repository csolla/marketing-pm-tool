import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { esc, avatar, toast, errorMessage, ROLES } from '../ui.js';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function renderProfile(el) {
  const me = state.me;
  el.innerHTML = `
    <div class="page-header"><h1>Profile</h1></div>
    <form class="card profile-form" novalidate>
      <div class="profile-photo">
        <div data-preview>${avatar(me, 96)}</div>
        <div class="photo-actions">
          <label class="btn">
            Upload photo
            <input type="file" accept="${PHOTO_TYPES.join(',')}" hidden data-file>
          </label>
          <button class="btn btn-ghost" type="button" data-remove ${me.photo_url ? '' : 'hidden'}>Remove photo</button>
          <p class="muted small">JPG, PNG, WebP or GIF, up to 2 MB.</p>
        </div>
      </div>
      <label class="field"><span>Name</span>
        <input name="name" required maxlength="100" value="${esc(me.name)}"></label>
      <div class="field"><span>Email</span><p>${esc(me.email)}</p></div>
      <div class="field"><span>Role</span><p>${esc(ROLES[me.role])}</p></div>
      <p class="form-error" hidden></p>
      <div><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`;

  const form = el.querySelector('form');
  const errorBox = form.querySelector('.form-error');
  const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    showError('');
    const name = form.elements.name.value.trim();
    if (!name) return showError('Your name can’t be empty.');
    const ok = await savePerson({ name });
    if (ok) toast('Profile saved');
  });

  form.querySelector('[data-file]').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    showError('');
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) return showError('Choose a JPG, PNG, WebP or GIF image.');
    if (file.size > MAX_PHOTO_BYTES) return showError('That photo is larger than 2 MB. Choose a smaller one.');

    const extension = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${me.id}/${Date.now()}.${extension}`;
    const { error } = await supabase.storage.from('avatars').upload(path, file, { contentType: file.type });
    if (error) return showError(errorMessage(error));

    const oldUrl = state.me.photo_url;
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    if (await savePerson({ photo_url: data.publicUrl })) {
      removeStoredPhoto(oldUrl);
      toast('Photo updated');
      renderProfile(el);
    }
  });

  form.querySelector('[data-remove]').addEventListener('click', async () => {
    const oldUrl = state.me.photo_url;
    if (await savePerson({ photo_url: null })) {
      removeStoredPhoto(oldUrl);
      toast('Photo removed');
      renderProfile(el);
    }
  });

  async function savePerson(values) {
    const { error } = await supabase.from('people').update(values).eq('id', me.id);
    if (error) {
      showError(errorMessage(error));
      return false;
    }
    Object.assign(state.me, values);
    const listed = state.people.find(p => p.id === me.id);
    if (listed) Object.assign(listed, values);
    window.dispatchEvent(new Event('me-updated'));
    return true;
  }
}

// Tidy up the previous file in storage; failures are harmless
function removeStoredPhoto(url) {
  const marker = '/storage/v1/object/public/avatars/';
  if (!url || !url.includes(marker)) return;
  supabase.storage.from('avatars').remove([decodeURIComponent(url.split(marker)[1])]);
}
