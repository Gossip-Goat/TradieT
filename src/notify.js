// Sends the tradie a notification carrying the triaged priority.
// Channels: Twilio SMS, Twilio voice call (emergencies), ntfy.sh push. Every attempt is
// logged so the dashboard shows what was sent, even when no channel is configured.

import twilio from 'twilio';
import { config, twilioConfigured } from './config.js';
import { logNotification, updateJob, getDb, getSettings } from './db.js';
import { localParts } from './hours.js';

const LABEL = { emergency: '🚨 EMERGENCY', urgent: '⚠️ URGENT', routine: '📋 Routine', not_a_job: 'Not a job' };

let twilioClient;
const getTwilio = () => (twilioClient ??= twilio(config.twilio.accountSid, config.twilio.authToken));

export function jobMessage(job) {
  const lines = [
    `${LABEL[job.priority] ?? job.priority} (${job.source}) #${job.id}`,
    job.summary,
    [job.customer_name, job.customer_phone || job.customer_email].filter(Boolean).join(' · '),
    [job.address, job.suburb].filter(Boolean).join(', '),
  ];
  if (config.publicUrl) lines.push(`${config.publicUrl}/#job-${job.id}`);
  return lines.filter(Boolean).join('\n');
}

/** Notify the tradie about one job. Returns the list of channels attempted. */
export async function notifyJob(job, { settings = getSettings(), transport = defaultTransport } = {}) {
  const body = jobMessage(job);
  const channels = [];

  channels.push(await attempt(job, 'sms', body, () => transport.sms(config.business.tradieMobile, body)));
  if (job.priority === 'emergency' && settings.callForEmergencies) {
    const speech = `Emergency job from ${job.customer_name || 'a customer'}. ${job.summary}. Check your messages for details.`;
    channels.push(await attempt(job, 'call', speech, () => transport.call(config.business.tradieMobile, speech)));
  }
  channels.push(
    await attempt(job, 'push', body, () =>
      transport.push(body, job.priority === 'emergency' ? 'urgent' : job.priority === 'urgent' ? 'high' : 'default'),
    ),
  );

  const sent = channels.filter((c) => c.status === 'sent').map((c) => c.channel);
  updateJob(job.id, {
    notified_at: new Date().toISOString(),
    notify_channel: sent.length ? sent.join(',') : 'dashboard',
  });
  return channels;
}

async function attempt(job, channel, body, fn) {
  try {
    const result = await fn();
    const status = result === false ? 'skipped' : 'sent';
    logNotification({ job_id: job?.id, channel, status, body, error: result === false ? 'not configured' : null });
    return { channel, status };
  } catch (err) {
    logNotification({ job_id: job?.id, channel, status: 'failed', body, error: String(err?.message ?? err) });
    return { channel, status: 'failed', error: String(err?.message ?? err) };
  }
}

export const defaultTransport = {
  async sms(to, body) {
    if (!twilioConfigured() || !to) return false;
    await getTwilio().messages.create({ to, from: config.twilio.fromNumber, body });
  },
  async call(to, speech) {
    if (!twilioConfigured() || !to) return false;
    const vr = new twilio.twiml.VoiceResponse();
    vr.say({ voice: 'Polly.Olivia', language: 'en-AU' }, speech);
    vr.pause({ length: 1 });
    vr.say({ voice: 'Polly.Olivia', language: 'en-AU' }, speech);
    await getTwilio().calls.create({ to, from: config.twilio.fromNumber, twiml: vr.toString() });
  },
  async push(body, priority) {
    if (!config.ntfyTopic) return false;
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: 'POST',
      headers: { Priority: priority, Title: config.business.name },
      body,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  },
};

// ---------- Morning digest for jobs held back overnight ----------

export async function sendDigest({ transport = defaultTransport } = {}) {
  const held = getDb()
    .prepare(
      `SELECT * FROM jobs WHERE notified_at IS NULL AND priority != 'not_a_job'
       AND status = 'new' ORDER BY priority_score DESC, created_at ASC`,
    )
    .all();
  if (!held.length) return { count: 0 };
  const counts = held.reduce((acc, j) => ({ ...acc, [j.priority]: (acc[j.priority] ?? 0) + 1 }), {});
  const header = `Good morning ${config.business.tradieName}. Overnight: ${Object.entries(counts)
    .map(([p, n]) => `${n} ${p}`)
    .join(', ')}.`;
  const lines = held.slice(0, 8).map((j) => `#${j.id} [${j.priority}] ${j.summary}${j.suburb ? ` (${j.suburb})` : ''}`);
  if (held.length > 8) lines.push(`+${held.length - 8} more on the dashboard`);
  const body = [header, ...lines].join('\n');

  await attempt(null, 'sms-digest', body, () => transport.sms(config.business.tradieMobile, body));
  await attempt(null, 'push-digest', body, () => transport.push(body, 'default'));
  const now = new Date().toISOString();
  for (const j of held) updateJob(j.id, { notified_at: now, notify_channel: 'digest' });
  return { count: held.length, body };
}

let lastDigestDay = null;
export function startDigestScheduler() {
  return setInterval(() => {
    const settings = getSettings();
    const { time } = localParts();
    const today = new Date().toLocaleDateString('en-AU', { timeZone: config.business.timezone });
    if (time === settings.digestTime && lastDigestDay !== today) {
      lastDigestDay = today;
      sendDigest().catch((e) => console.error('[digest]', e));
    }
  }, 30_000).unref();
}
