import { supabase } from './supabase.js';

// One live connection for changes made by anyone. Each change is passed on
// as a window event, which pages listen to.
const EVENTS = {
  tasks: 'tasks-changed',
  time_entries: 'time-changed',
  timers: 'timer-changed',
  comments: 'comments-changed',
  attachments: 'attachments-changed',
  notifications: 'notifications-changed',
};

let channel = null;

export function startRealtime() {
  if (channel) return;
  channel = supabase.channel('live');
  Object.entries(EVENTS).forEach(([table, eventName]) => {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload =>
      window.dispatchEvent(new CustomEvent(eventName, { detail: payload })));
  });
  channel.subscribe();
}

export function stopRealtime() {
  if (channel) supabase.removeChannel(channel);
  channel = null;
}

// Tell open pages something changed. Live updates do the same for other
// people's changes; this makes your own changes show immediately.
export function announce(eventName) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: { local: true } }));
}

// Calls handler (at most every `delay` ms) when any of `eventNames` fires,
// while `el` is on the page; stops listening once the page is left. If
// isBusy() says the person is mid-drag or mid-typing, the refresh waits.
export function onLiveChange(el, eventNames, handler, { delay = 250, isBusy = () => false } = {}) {
  const names = [].concat(eventNames);
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
      names.forEach(name => window.removeEventListener(name, listener));
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  names.forEach(name => window.addEventListener(name, listener));
}

export function onTasksChanged(el, handler, options) {
  onLiveChange(el, 'tasks-changed', handler, options);
}
