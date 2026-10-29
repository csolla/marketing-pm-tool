import { state, isAdmin, canEditWork } from '../state.js';
import { onLiveChange } from '../realtime.js';
import {
  loadAttachments, uploadFile, addLink, deleteAttachment, fileUrl, fmtSize, isImage, linkSite, MAX_FILE_BYTES,
} from '../attachments.js';
import { renderBody, commentEditor, loadComments, addComment, editComment, deleteComment } from '../comments.js';
import { esc, avatar, toast, errorMessage, confirmDialog, formDialog } from '../ui.js';

// When something happened: "just now", "5 min ago", "3 h ago", or a date
export function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// Attachments ---------------------------------------------------------------------

export function mountAttachments(container, task) {
  container.innerHTML = `
    <h3>Attachments <span class="muted" data-count></span></h3>
    <div data-list></div>
    ${canEditWork() ? `
      <div class="drop-zone" data-drop tabindex="0" role="button" aria-label="Upload files">
        <span>Drop files here or <u>click to upload</u></span>
        <span class="muted small">Up to 25 MB each</span>
        <input type="file" multiple hidden data-file>
      </div>
      <button class="btn btn-small" type="button" data-add-link>Add a link (Drive, Canva, Figma…)</button>` : ''}`;

  const list = container.querySelector('[data-list]');
  let items = [];

  const draw = async () => {
    try {
      items = await loadAttachments(task.id);
    } catch (error) {
      list.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
      return;
    }
    container.querySelector('[data-count]').textContent = items.length ? items.length : '';
    if (!items.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = `<ul class="attachment-list">${items.map(a => {
      const by = state.people.find(p => p.id === a.uploaded_by);
      const canDelete = (a.uploaded_by === state.me.id && canEditWork()) || isAdmin();
      const meta = a.kind === 'link' ? linkSite(a.url) : fmtSize(a.size);
      return `
        <li class="attachment" data-id="${esc(a.id)}">
          ${isImage(a)
            ? '<button type="button" class="thumb" data-preview aria-label="Preview image"><span class="muted small">…</span></button>'
            : `<span class="file-icon" aria-hidden="true">${a.kind === 'link' ? '🔗' : '📄'}</span>`}
          <span class="attachment-main">
            ${a.kind === 'link'
              ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a>`
              : `<span class="attachment-name">${esc(a.name)}</span>`}
            <span class="muted small">${esc(meta)} · ${esc(by?.name || '')} · ${esc(timeAgo(a.created_at))}</span>
          </span>
          ${a.kind === 'file' ? '<button class="btn btn-small" type="button" data-download>Download</button>' : ''}
          ${canDelete ? '<button class="icon-btn" type="button" data-delete aria-label="Delete attachment">×</button>' : ''}
        </li>`;
    }).join('')}</ul>`;

    // Image thumbnails load through short-lived private links
    list.querySelectorAll('[data-preview]').forEach(async button => {
      const a = items.find(i => i.id === button.closest('li').dataset.id);
      try {
        const url = await fileUrl(a);
        button.innerHTML = `<img src="${esc(url)}" alt="${esc(a.name)}">`;
        button.addEventListener('click', () => previewImage(a, url));
      } catch {
        button.innerHTML = '<span aria-hidden="true">🖼️</span>';
      }
    });
  };

  list.addEventListener('click', async event => {
    const row = event.target.closest('li[data-id]');
    if (!row) return;
    const a = items.find(i => i.id === row.dataset.id);
    if (event.target.closest('[data-download]')) {
      try {
        window.location.href = await fileUrl(a, { download: true });
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
    if (event.target.closest('[data-delete]')) {
      const ok = await confirmDialog({
        title: 'Delete attachment?', message: `“${a.name}” will be removed from this task for everyone.`,
        confirmLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      try {
        await deleteAttachment(a);
        toast('Attachment deleted');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
  });

  const upload = async files => {
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        toast(`“${file.name}” is larger than 25 MB.`, 'error');
        continue;
      }
      toast(`Uploading ${file.name}…`);
      try {
        await uploadFile(task.id, file);
        toast(`Uploaded ${file.name}`);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
  };

  const drop = container.querySelector('[data-drop]');
  if (drop) {
    const input = container.querySelector('[data-file]');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') input.click(); });
    input.addEventListener('change', () => { upload([...input.files]); input.value = ''; });
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('is-over');
      upload([...event.dataTransfer.files]);
    });
    container.querySelector('[data-add-link]').addEventListener('click', () => formDialog({
      title: 'Add a link',
      submitLabel: 'Add link',
      body: `
        <label class="field"><span>Link</span><input name="url" type="url" required placeholder="https://www.canva.com/design/…"></label>
        <label class="field"><span>Name <span class="muted">(optional)</span></span><input name="name" maxlength="200"></label>`,
      onSubmit: async form => {
        const url = form.elements.url.value.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) return 'Paste a full link starting with https://';
        await addLink(task.id, url, form.elements.name.value.trim());
        toast('Link added');
      },
    }));
  }

  draw();
  onLiveChange(container, 'attachments-changed', draw, { delay: 300 });
}

function previewImage(attachment, url) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog image-preview';
  dialog.innerHTML = `
    <div class="dialog-form">
      <header class="dialog-header">
        <h2>${esc(attachment.name)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
      </header>
      <img src="${esc(url)}" alt="${esc(attachment.name)}">
      <footer class="dialog-footer"><button class="btn" type="button" data-download>Download</button></footer>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-download]').addEventListener('click', async () => {
    window.location.href = await fileUrl(attachment, { download: true });
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// Comments ------------------------------------------------------------------------

export function mountComments(container, task) {
  container.innerHTML = `
    <h3>Comments <span class="muted" data-count></span></h3>
    <ol class="comment-list" data-list></ol>
    ${canEditWork() ? `
      <form class="comment-form" data-form>
        <div data-editor></div>
        <div class="comment-form-actions"><button class="btn btn-primary btn-small" type="submit">Comment</button></div>
      </form>` : ''}`;

  const list = container.querySelector('[data-list]');
  let comments = [];
  let editingId = null;

  const draw = async () => {
    // Don't redraw under someone editing a comment
    if (editingId) return;
    try {
      comments = await loadComments(task.id);
    } catch (error) {
      list.innerHTML = `<li class="form-error">${esc(errorMessage(error))}</li>`;
      return;
    }
    container.querySelector('[data-count]').textContent = comments.length ? comments.length : '';
    list.innerHTML = comments.length ? comments.map(c => {
      const author = state.people.find(p => p.id === c.author_id);
      const mine = c.author_id === state.me.id && canEditWork();
      return `
        <li class="comment" data-id="${esc(c.id)}">
          ${avatar(author, 32)}
          <div class="comment-main">
            <div class="comment-head">
              <strong>${esc(author?.name || 'Someone')}</strong>
              <span class="muted small" title="${esc(new Date(c.created_at).toLocaleString('en-GB'))}">${esc(timeAgo(c.created_at))}${c.edited_at ? ' · edited' : ''}</span>
              ${mine ? `<span class="comment-actions">
                <button class="btn btn-small btn-ghost" type="button" data-edit>Edit</button>
                <button class="btn btn-small btn-ghost" type="button" data-delete>Delete</button></span>` : ''}
            </div>
            <div class="comment-body">${renderBody(c.body)}</div>
          </div>
        </li>`;
    }).join('') : '<li class="muted small">No comments yet.</li>';
  };

  list.addEventListener('click', async event => {
    const row = event.target.closest('li[data-id]');
    if (!row) return;
    const comment = comments.find(c => c.id === row.dataset.id);
    if (event.target.closest('[data-delete]')) {
      const ok = await confirmDialog({ title: 'Delete comment?', message: 'Your comment will be removed for everyone.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await deleteComment(comment.id);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
    if (event.target.closest('[data-edit]')) {
      editingId = comment.id;
      const editor = commentEditor({ initial: comment.body, placeholder: 'Edit your comment' });
      const body = row.querySelector('.comment-body');
      body.replaceChildren(editor.el);
      const actions = document.createElement('div');
      actions.className = 'comment-form-actions';
      actions.innerHTML = '<button class="btn btn-small" type="button" data-cancel>Cancel</button><button class="btn btn-primary btn-small" type="button" data-save>Save</button>';
      body.append(actions);
      editor.focus();
      actions.querySelector('[data-cancel]').addEventListener('click', () => { editingId = null; draw(); });
      actions.querySelector('[data-save]').addEventListener('click', async () => {
        const value = editor.read();
        if (!value.body) return;
        try {
          await editComment(comment.id, value);
          editingId = null;
          draw();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      });
    }
  });

  const form = container.querySelector('[data-form]');
  if (form) {
    const editor = commentEditor();
    form.querySelector('[data-editor]').replaceWith(editor.el);
    const submit = async event => {
      event?.preventDefault();
      const value = editor.read();
      if (!value.body) return;
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        await addComment(task.id, value);
        editor.clear();
        await draw();
        list.lastElementChild?.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        button.disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    // Cmd/Ctrl + Enter sends
    editor.el.querySelector('textarea').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
    });
  }

  draw();
  onLiveChange(container, 'comments-changed', draw, { delay: 300 });
}
