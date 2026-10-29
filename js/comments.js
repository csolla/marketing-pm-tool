import { supabase } from './supabase.js';
import { state } from './state.js';
import { announce } from './realtime.js';
import { esc } from './ui.js';

// Comments are stored as plain text with a little formatting:
//   **bold**, lines starting with "- " become a bullet list, links are
//   recognised automatically, and mentions are stored as @[Name](person-id).
const MENTION = /@\[([^\]]+)\]\(([0-9a-f-]{36})\)/g;

function formatLine(text) {
  return esc(text)
    .replace(/@\[([^\]]+)\]\(([0-9a-f-]{36})\)/g, '<span class="mention">@$1</span>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+?)([.,)]*(?:\s|$))/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>$2');
}

// Safe HTML for a comment body (everything is escaped first)
export function renderBody(body) {
  const lines = String(body).split('\n');
  let html = '';
  let list = [];
  const flush = () => {
    if (list.length) html += `<ul>${list.map(item => `<li>${formatLine(item)}</li>`).join('')}</ul>`;
    list = [];
  };
  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flush();
    html += formatLine(line) + (i < lines.length - 1 ? '<br>' : '');
  });
  flush();
  return html;
}

// People who can be mentioned: active admins and team members
export const mentionable = () => state.people.filter(p => p.active && p.role !== 'director');

// In the editor mentions show as "@Name"; stored ones become tokens again
export function toEditorText(body) {
  return String(body).replace(MENTION, '@$1');
}

// Turn "@Name" back into tokens for the people picked in this editor
function toStoredText(text, picked) {
  let body = text;
  const ids = [];
  [...picked.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([name, id]) => {
      const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
      if (pattern.test(body)) {
        body = body.replace(pattern, `@[${name}](${id})`);
        ids.push(id);
      }
    });
  return { body, mentions: ids };
}

// A comment editor: textarea, B / list buttons, and an @ picker.
// Returns { el, read(), clear(), focus() }; read() gives { body, mentions }.
export function commentEditor({ initial = '', placeholder = 'Write a comment… Type @ to mention someone' } = {}) {
  const picked = new Map();
  [...String(initial).matchAll(MENTION)].forEach(m => picked.set(m[1], m[2]));

  const el = document.createElement('div');
  el.className = 'comment-editor';
  el.innerHTML = `
    <div class="editor-tools">
      <button type="button" class="tool" data-bold title="Bold" aria-label="Bold"><strong>B</strong></button>
      <button type="button" class="tool" data-list title="Bullet list" aria-label="Bullet list">• List</button>
    </div>
    <textarea rows="3" placeholder="${esc(placeholder)}" aria-label="Comment">${esc(toEditorText(initial))}</textarea>
    <ul class="mention-picker" role="listbox" hidden></ul>`;
  const textarea = el.querySelector('textarea');
  const picker = el.querySelector('.mention-picker');
  let matches = [];
  let active = 0;

  const wrapSelection = (before, after = before) => {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end) || 'text';
    textarea.value = value.slice(0, start) + before + selected + after + value.slice(end);
    textarea.focus();
    textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
  };
  el.querySelector('[data-bold]').addEventListener('click', () => wrapSelection('**'));
  el.querySelector('[data-list]').addEventListener('click', () => {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const block = value.slice(lineStart, end).split('\n').map(l => (l.startsWith('- ') ? l : `- ${l}`)).join('\n');
    textarea.value = value.slice(0, lineStart) + block + value.slice(end);
    textarea.focus();
  });

  // The "@word" right before the cursor, if any
  const currentQuery = () => {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    return match ? { text: match[1], start: textarea.selectionStart - match[1].length - 1 } : null;
  };

  const closePicker = () => { picker.hidden = true; matches = []; };
  const choose = person => {
    const query = currentQuery();
    if (!query) return closePicker();
    const value = textarea.value;
    const insert = `@${person.name} `;
    textarea.value = value.slice(0, query.start) + insert + value.slice(textarea.selectionStart);
    const caret = query.start + insert.length;
    textarea.setSelectionRange(caret, caret);
    picked.set(person.name, person.id);
    closePicker();
    textarea.focus();
  };
  const showPicker = () => {
    const query = currentQuery();
    if (!query) return closePicker();
    const q = query.text.toLowerCase();
    matches = mentionable().filter(p => p.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) return closePicker();
    active = Math.min(active, matches.length - 1);
    picker.innerHTML = matches.map((p, i) =>
      `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">${esc(p.name)}</li>`).join('');
    picker.hidden = false;
  };

  textarea.addEventListener('input', () => { active = 0; showPicker(); });
  textarea.addEventListener('keydown', event => {
    if (picker.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      showPicker();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      closePicker();
    }
  });
  picker.addEventListener('mousedown', event => {
    const item = event.target.closest('[data-i]');
    if (item) {
      event.preventDefault();
      choose(matches[Number(item.dataset.i)]);
    }
  });
  textarea.addEventListener('blur', () => setTimeout(closePicker, 150));

  return {
    el,
    read: () => toStoredText(textarea.value.trim(), picked),
    clear: () => { textarea.value = ''; picked.clear(); },
    focus: () => textarea.focus(),
  };
}

// Data -------------------------------------------------------------------------

export async function loadComments(taskId) {
  const { data, error } = await supabase.from('comments').select('*').eq('task_id', taskId).order('created_at');
  if (error) throw error;
  return data;
}

export async function addComment(taskId, { body, mentions }) {
  const { error } = await supabase.from('comments').insert({ task_id: taskId, author_id: state.me.id, body, mentions });
  if (error) throw error;
  announce('comments-changed');
}

export async function editComment(id, { body, mentions }) {
  const { error } = await supabase.from('comments').update({ body, mentions }).eq('id', id);
  if (error) throw error;
  announce('comments-changed');
}

export async function deleteComment(id) {
  const { error } = await supabase.from('comments').delete().eq('id', id);
  if (error) throw error;
  announce('comments-changed');
}
