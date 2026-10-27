import { supabase } from './supabase.js';

// One live connection for task changes made by anyone. Each change is passed
// on as a 'tasks-changed' window event, which pages listen to.
let channel = null;

export function startRealtime() {
  if (channel) return;
  channel = supabase
    .channel('tasks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, payload =>
      window.dispatchEvent(new CustomEvent('tasks-changed', { detail: payload })))
    .subscribe();
}

export function stopRealtime() {
  if (channel) supabase.removeChannel(channel);
  channel = null;
}

// Calls handler (at most every `delay` ms) while `el` is on the page; stops
// listening once the page is left. If isBusy() says the person is mid-drag or
// mid-typing, the refresh waits until they're done.
export function onTasksChanged(el, handler, { delay = 250, isBusy = () => false } = {}) {
  let timer = null;
  const run = () => {
    if (!el.isConnected) return;
    if (isBusy()) {
      timer = setTimeout(run, 500);
      return;
    }
    handler();
  };
  const listener = () => {
    if (!el.isConnected) {
      window.removeEventListener('tasks-changed', listener);
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  window.addEventListener('tasks-changed', listener);
}
