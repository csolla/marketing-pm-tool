import { supabase } from '../supabase.js';
import { canEditWork, isAdmin, personById } from '../state.js';
import {
  esc, buTag, statusPill, avatar, fmtDateRange, fmtHours, toast, errorMessage, confirmDialog,
} from '../ui.js';
import { openCampaignForm, campaignProgress } from './campaigns.js';

export async function renderCampaign(el, id) {
  el.innerHTML = '<p class="muted">Loading campaign…</p>';

  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
  if (error) {
    el.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  if (!campaign) {
    el.innerHTML = `
      <a class="back-link" href="#/campaigns">← Campaigns</a>
      <div class="empty-state"><p>This campaign doesn't exist or was deleted.</p></div>`;
    return;
  }

  const owner = personById(campaign.owner_id);
  const progress = campaignProgress(campaign);

  el.innerHTML = `
    <a class="back-link" href="#/campaigns">← Campaigns</a>
    <section class="card campaign-head">
      <div class="campaign-title">
        <div>
          <div class="tags">${buTag(campaign.business_unit)} ${statusPill(campaign.status)}</div>
          <h1>${esc(campaign.name)}</h1>
        </div>
        <div class="actions">
          ${canEditWork() ? '<button class="btn" type="button" data-edit>Edit</button>' : ''}
          ${isAdmin() ? '<button class="btn btn-danger-outline" type="button" data-delete>Delete</button>' : ''}
        </div>
      </div>
      ${campaign.description
        ? `<p class="description">${esc(campaign.description)}</p>`
        : '<p class="muted">No description.</p>'}
      <dl class="details">
        <div><dt>Dates</dt><dd>${esc(fmtDateRange(campaign.start_date, campaign.end_date))}</dd></div>
        <div><dt>Owner</dt><dd>${owner ? `<span class="person">${avatar(owner, 24)}${esc(owner.name)}</span>` : '—'}</dd></div>
        <div><dt>Hours logged / planned</dt><dd>${fmtHours(progress.hoursLogged)} / ${fmtHours(campaign.planned_hours)}</dd></div>
        <div><dt>Tasks done</dt><dd>${progress.tasksDonePct == null ? '—' : `${progress.tasksDonePct}%`}</dd></div>
      </dl>
    </section>
    <section class="section">
      <h2>Tasks</h2>
      <div class="empty-state" data-tasks><p>Tasks for this campaign will appear here.</p></div>
    </section>`;

  el.querySelector('[data-edit]')?.addEventListener('click', () =>
    openCampaignForm(campaign, () => renderCampaign(el, id)));

  el.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete campaign?',
      message: `“${campaign.name}” will be deleted for everyone. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const { error: deleteError } = await supabase.from('campaigns').delete().eq('id', id);
    if (deleteError) {
      toast(errorMessage(deleteError), 'error');
      return;
    }
    toast('Campaign deleted');
    window.location.hash = '/campaigns';
  });
}
