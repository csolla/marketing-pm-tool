import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { todayIso, byPosition } from '../tasks.js';
import { parseHours, hoursText, createEntry, updateEntry } from '../time.js';
import { esc, formDialog, errorMessage } from '../ui.js';

const INTERNAL = 'internal';
const NEEDS_TASK = 'Choose a task. Campaign time always goes on a task; if none fits, add one on the campaign page first.';

async function loadCampaigns() {
  const { data, error } = await supabase.from('campaigns').select('id, name, business_unit, status').order('name');
  if (error) throw error;
  return data;
}

async function loadTasks(campaignId) {
  if (!campaignId || campaignId === INTERNAL) return [];
  const { data, error } = await supabase
    .from('tasks').select('id, title, parent_id, position, created_at').eq('campaign_id', campaignId);
  if (error) throw error;
  return data;
}

function campaignOptions(campaigns, selected) {
  const option = c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`;
  const active = campaigns.filter(c => c.status === 'planned' || c.status === 'in_progress');
  const other = campaigns.filter(c => !active.includes(c));
  return `
    <option value="">Choose a campaign…</option>
    <option value="${INTERNAL}"${selected === INTERNAL ? ' selected' : ''}>Internal (no campaign)</option>
    ${active.length ? `<optgroup label="Active">${active.map(option).join('')}</optgroup>` : ''}
    ${other.length ? `<optgroup label="Done or on hold">${other.map(option).join('')}</optgroup>` : ''}`;
}

// Main tasks in board order, each followed by its subtasks
function taskOptions(tasks, selected) {
  const main = tasks.filter(t => !t.parent_id).sort(byPosition);
  const option = (t, indent) =>
    `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${indent ? '   ↳ ' : ''}${esc(t.title)}</option>`;
  return `<option value="">Choose a task…</option>${main.map(t =>
    option(t, false) + tasks.filter(s => s.parent_id === t.id).sort(byPosition).map(s => option(s, true)).join('')).join('')}`;
}

// Keeps the task list in step with the chosen campaign
function wireCampaignTask(form, selectedTask) {
  const campaignSelect = form.elements.campaign_id;
  const taskSelect = form.elements.task_id;
  const refresh = async keep => {
    taskSelect.disabled = true;
    taskSelect.innerHTML = '<option value="">Loading…</option>';
    try {
      const campaign = campaignSelect.value;
      const tasks = await loadTasks(campaign);
      if (!campaign || campaign === INTERNAL) {
        taskSelect.innerHTML = `<option value="">${campaign ? 'No task for Internal time' : 'Choose a campaign first'}</option>`;
        taskSelect.disabled = true;
      } else if (!tasks.length) {
        taskSelect.innerHTML = '<option value="">This campaign has no tasks yet</option>';
        taskSelect.disabled = true;
      } else {
        taskSelect.innerHTML = taskOptions(tasks, keep);
        taskSelect.disabled = false;
      }
    } catch (error) {
      taskSelect.innerHTML = `<option value="">${esc(errorMessage(error))}</option>`;
    }
  };
  campaignSelect.addEventListener('change', () => refresh(null));
  refresh(selectedTask);
}

const campaignTaskFields = (campaigns, campaignId) => `
  <label class="field"><span>Campaign</span>
    <select name="campaign_id">${campaignOptions(campaigns, campaignId)}</select></label>
  <label class="field"><span>Task</span>
    <select name="task_id" disabled></select></label>`;

const readCampaignTask = form => {
  const campaign = form.elements.campaign_id.value;
  return {
    campaign_id: campaign === INTERNAL ? null : campaign || undefined,
    task_id: campaign === INTERNAL ? null : form.elements.task_id.value || null,
  };
};

// Add time (entry = null) or edit an entry.
// defaults: { campaign_id (null = Internal, undefined = not chosen), task_id, entry_date, minutes, note }
// Returns the dialog, so callers can add buttons (the timer adds "Discard").
export async function openTimeEntryForm({
  entry = null, defaults = {}, personId = state.me.id, title, submitLabel, onSaved,
} = {}) {
  const campaigns = await loadCampaigns();
  const values = entry || defaults;
  const campaignId = entry
    ? entry.campaign_id ?? INTERNAL
    : defaults.campaign_id === null ? INTERNAL : defaults.campaign_id || '';
  const person = state.people.find(p => p.id === (entry?.person_id || personId));

  const dialog = formDialog({
    title: title || (entry ? 'Edit time' : 'Add time'),
    submitLabel: submitLabel || 'Save',
    body: `
      ${person && person.id !== state.me.id ? `<p class="muted form-note">For ${esc(person.name)}</p>` : ''}
      ${campaignTaskFields(campaigns, campaignId)}
      <div class="field-row">
        <label class="field"><span>Date</span>
          <input type="date" name="entry_date" required value="${esc(values.entry_date || todayIso())}"></label>
        <label class="field"><span>Hours</span>
          <input name="hours" inputmode="decimal" placeholder="e.g. 1.5 or 1:30" autocomplete="off"
            value="${esc(hoursText(values.minutes))}"></label>
      </div>
      <label class="field"><span>Note <span class="muted">(optional)</span></span>
        <input name="note" maxlength="500" value="${esc(values.note || '')}"></label>`,
    onSubmit: async form => {
      const { campaign_id, task_id } = readCampaignTask(form);
      if (campaign_id === undefined) return 'Choose a campaign, or Internal for non-campaign work.';
      if (campaign_id && !task_id) return NEEDS_TASK;
      const minutes = parseHours(form.elements.hours.value);
      if (minutes === null) return 'Type hours as a number, like 1.5 or 1:30.';
      if (minutes < 1) return 'Add how many hours.';
      if (minutes > 1440) return 'One entry can be at most 24 hours.';
      if (!form.elements.entry_date.value) return 'Choose a date.';

      const row = {
        campaign_id,
        task_id,
        entry_date: form.elements.entry_date.value,
        minutes,
        note: form.elements.note.value.trim() || null,
      };
      const saved = entry
        ? await updateEntry(entry.id, row)
        : await createEntry({ ...row, person_id: person?.id || state.me.id });
      await onSaved?.(saved);
    },
  });
  wireCampaignTask(dialog.querySelector('form'), values.task_id || null);
  return dialog;
}

// Pick a campaign/Internal and optional task (for a new My time row)
export async function pickCampaignTask({ title = 'Add a row', submitLabel = 'Add row', onPicked }) {
  const campaigns = await loadCampaigns();
  const dialog = formDialog({
    title,
    submitLabel,
    body: campaignTaskFields(campaigns, ''),
    onSubmit: form => {
      const picked = readCampaignTask(form);
      if (picked.campaign_id === undefined) return 'Choose a campaign, or Internal for non-campaign work.';
      if (picked.campaign_id && !picked.task_id) return NEEDS_TASK;
      const campaign = campaigns.find(c => c.id === picked.campaign_id) || null;
      const taskOption = form.elements.task_id.selectedOptions[0];
      onPicked({
        ...picked,
        campaign,
        taskTitle: picked.task_id ? taskOption.textContent.replace(/^[\s↳]+/, '') : null,
      });
    },
  });
  wireCampaignTask(dialog.querySelector('form'), null);
}
