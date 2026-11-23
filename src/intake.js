// The screening pipeline shared by phone, email and the dashboard tester:
// enquiry -> triage (priority decided) -> job saved -> tradie notified according to priority.

import { triage, PRIORITY_SCORE } from './triage.js';
import { createJob, getJob, getJobByRef, getSettings, updateJob } from './db.js';
import { isAfterHours, shouldNotifyNow } from './hours.js';
import { notifyJob } from './notify.js';

/**
 * @param {object} e
 * @param {'phone'|'email'|'manual'} e.source
 * @param {string} e.text           transcript or email body
 * @param {string} [e.from]         caller number or sender address
 * @param {string} [e.externalRef]  CallSid / Message-ID, used to ignore duplicates
 * @param {object} [e.known]        fields already known (customer_name, address, ...)
 */
export async function processEnquiry(e, { now = new Date(), notifier = notifyJob, timeoutMs } = {}) {
  if (e.externalRef) {
    const existing = getJobByRef(e.externalRef);
    if (existing) return { job: existing, duplicate: true };
  }

  const settings = getSettings();
  const afterHours = isAfterHours(settings, now);
  const t = await triage({ source: e.source, text: e.text, from: e.from }, { timeoutMs });

  const known = e.known ?? {};
  const pick = (k) => known[k] || t[k] || '';
  let job = createJob({
    source: e.source,
    priority: t.priority,
    priority_score: PRIORITY_SCORE[t.priority] ?? 0,
    category: t.category,
    summary: t.summary,
    reasoning: t.in_service_area === 'no' ? `${t.reasoning} Outside service area.` : t.reasoning,
    safety_advice: t.safety_advice,
    customer_name: pick('customer_name'),
    customer_phone: known.customer_phone || t.customer_phone || (e.source === 'phone' ? e.from : '') || '',
    customer_email: known.customer_email || (e.source === 'email' ? e.from : '') || '',
    address: pick('address'),
    suburb: pick('suburb'),
    details: e.text,
    triaged_by: t.triaged_by,
    after_hours: afterHours,
    external_ref: e.externalRef,
    status: t.priority === 'not_a_job' ? 'declined' : 'new',
  });

  let notification = 'held';
  if (e.source === 'manual') {
    job = updateJob(job.id, { notified_at: new Date().toISOString(), notify_channel: 'manual' });
    notification = 'manual';
  } else if (shouldNotifyNow(t.priority, settings, afterHours)) {
    await notifier(job, { settings });
    notification = 'sent';
  } else if (t.priority === 'not_a_job') {
    job = updateJob(job.id, { notified_at: new Date().toISOString(), notify_channel: 'filtered' });
    notification = 'filtered';
  }
  return { job: getJob(job.id), triage: t, afterHours, notification };
}
