import { supabase } from './supabase.js';
import { state } from './state.js';
import { announce } from './realtime.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BUCKET = 'attachments';

export function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const isImage = a => a.kind === 'file' && /^image\//.test(a.mime_type || '');

// A friendly name for a pasted link
export function linkSite(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/.test(host)) return 'Google Drive';
    if (/(^|\.)canva\.com$/.test(host)) return 'Canva';
    if (/(^|\.)figma\.com$/.test(host)) return 'Figma';
    return host;
  } catch {
    return 'Link';
  }
}

export async function loadAttachments(taskId) {
  const { data, error } = await supabase.from('attachments').select('*').eq('task_id', taskId).order('created_at');
  if (error) throw error;
  return data;
}

export async function uploadFile(taskId, file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}” is larger than 25 MB.`);
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
  const path = `${taskId}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;

  const { error } = await supabase.from('attachments').insert({
    task_id: taskId,
    uploaded_by: state.me.id,
    kind: 'file',
    name: file.name,
    size: file.size,
    mime_type: file.type || null,
    storage_path: path,
  });
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  announce('attachments-changed');
}

export async function addLink(taskId, url, name) {
  const { error } = await supabase.from('attachments').insert({
    task_id: taskId,
    uploaded_by: state.me.id,
    kind: 'link',
    name: name || linkSite(url),
    url,
  });
  if (error) throw error;
  announce('attachments-changed');
}

export async function deleteAttachment(attachment) {
  const { error } = await supabase.from('attachments').delete().eq('id', attachment.id);
  if (error) throw error;
  if (attachment.kind === 'file') await supabase.storage.from(BUCKET).remove([attachment.storage_path]);
  announce('attachments-changed');
}

// Files are private: open them through a link that works for an hour
export async function fileUrl(attachment, { download = false } = {}) {
  const { data, error } = await supabase.storage.from(BUCKET)
    .createSignedUrl(attachment.storage_path, 3600, download ? { download: attachment.name } : undefined);
  if (error) throw error;
  return data.signedUrl;
}
