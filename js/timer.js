import { supabase } from './supabase.js';
import { state } from './state.js';
import { announce } from './realtime.js';
import { isoDate } from './tasks.js';
import { esc, toast, errorMessage, confirmDialog } from './ui.js';
import { openTimeEntryForm } from './pages/time-entry-form.js';

// Your running timer (or null). It's stored in the database, so it keeps
// running after the browser is closed and shows on every device.
let timer = null;
let slot = null;
let ticking = null;

export const runningTimer = () => timer;

export async function loadTimer() {
  const { data, error } = await supabase
    .from('timers').select('*, campaign:campaigns(id, name), task:tasks(id, title)')
    .eq('person_id', state.me.id).maybeSingle();
  if (error) throw error;
  timer = data;
  drawBar();
  return timer;
}

export function clearTimer() {
  timer = null;
  slot = null;
  clearInterval(ticking);
}

// The clock in the top bar
export function mountTimerBar(container) {
  slot = container;
  drawBar();
  clearInterval(ticking);
  ticking = setInterval(updateClock, 1000);
}

window.addEventListener('timer-changed', () => {
  if (state.me && slot) loadTimer().catch(() => {});
});

function label(t) {
  return t.task?.title || t.campaign?.name || 'Timer';
}

function elapsedText() {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timer.started_at)) / 1000));
  const pad = n => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function drawBar() {
  if (!slot) return;
  if (!timer) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `
    <div class="timer-bar" title="Timer running">
      <span class="timer-dot" aria-hidden="true"></span>
      <span class="timer-clock" data-timer-clock>${elapsedText()}</span>
      <span class="timer-label">${esc(label(timer))}</span>
      <button class="btn btn-small" type="button" data-stop>Stop</button>
    </div>`;
  slot.querySelector('[data-stop]').addEventListener('click', () => stopTimer());
}

function updateClock() {
  const clock = slot?.querySelector('[data-timer-clock]');
  if (clock && timer) clock.textContent = elapsedText();
}

// Start a timer, optionally on a campaign and task. If one is already
// running, offer to stop and save it first.
export async function startTimer({ campaign_id = null, task_id = null } = {}) {
  if (timer) {
    const ok = await confirmDialog({
      title: 'A timer is already running',
      message: `Only one timer can run at a time. Stop the timer for “${label(timer)}” and save its time first?`,
      confirmLabel: 'Stop and save',
    });
    if (!ok || !(await stopTimer())) return;
  }
  const { error } = await supabase.from('timers').insert({ campaign_id, task_id });
  if (error) {
    toast(errorMessage(error), 'error');
    await loadTimer().catch(() => {});
    return;
  }
  await loadTimer();
  announce('timer-changed');
  toast('Timer started');
}

async function removeTimer() {
  const { error } = await supabase.from('timers').delete().eq('person_id', state.me.id);
  if (error) throw error;
  timer = null;
  drawBar();
  announce('timer-changed');
}

// Opens the time form with the timer's time rounded to the nearest 5 minutes
// (at least 5). Resolves true once the time is saved or the timer discarded,
// false if the person cancels (the timer keeps running).
export function stopTimer() {
  if (!timer) return Promise.resolve(true);
  const running = timer;
  const elapsedMinutes = (Date.now() - new Date(running.started_at)) / 60000;
  const minutes = Math.min(1440, Math.max(5, Math.round(elapsedMinutes / 5) * 5));

  return new Promise(resolve => {
    let done = false;
    openTimeEntryForm({
      title: 'Save timer',
      submitLabel: 'Save time',
      defaults: {
        campaign_id: running.campaign_id ?? undefined,
        task_id: running.task_id,
        entry_date: isoDate(new Date(running.started_at)),
        minutes,
      },
      onSaved: async () => {
        done = true;
        await removeTimer();
        toast('Time saved');
      },
    }).then(dialog => {
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'btn btn-ghost btn-discard';
      discard.textContent = 'Discard timer';
      discard.addEventListener('click', async () => {
        try {
          await removeTimer();
          done = true;
          toast('Timer discarded');
          dialog.close();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      });
      dialog.querySelector('.dialog-footer').prepend(discard);
      dialog.addEventListener('close', () => resolve(done));
    }).catch(error => {
      toast(errorMessage(error), 'error');
      resolve(false);
    });
  });
}
