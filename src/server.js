import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, twilioConfigured } from './config.js';
import { getJob, getSettings, listJobs, listNotifications, updateJob, updateSettings } from './db.js';
import { isAfterHours } from './hours.js';
import { processEnquiry } from './intake.js';
import { PRIORITIES, PRIORITY_SCORE } from './triage.js';
import { notifyJob, sendDigest, startDigestScheduler } from './notify.js';
import { voiceRouter } from './voice.js';
import { emailRouter } from './email.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATUSES = ['new', 'accepted', 'scheduled', 'in_progress', 'done', 'declined'];

export function createApp({ notifier = notifyJob } = {}) {
  const app = express();
  app.set('trust proxy', true);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/webhooks/voice', voiceRouter({ notifier }));
  app.use('/webhooks/email', emailRouter({ notifier }));

  // Everything below is the tradie's dashboard.
  app.use(basicAuth);
  app.use(express.json());
  app.use(express.static(path.join(here, '..', 'public')));

  app.get('/api/status', (_req, res) => {
    const settings = getSettings();
    res.json({
      business: config.business,
      afterHoursNow: isAfterHours(settings),
      integrations: {
        claude: config.anthropic.enabled,
        twilio: twilioConfigured(),
        tradieMobile: Boolean(config.business.tradieMobile),
        ntfy: Boolean(config.ntfyTopic),
        emailAutoReply: Boolean(config.email.sendgridApiKey && config.email.fromAddress),
        publicUrl: config.publicUrl,
      },
    });
  });

  app.get('/api/jobs', (req, res) => res.json(listJobs({ status: req.query.status, priority: req.query.priority })));

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(Number(req.params.id));
    job ? res.json(job) : res.status(404).json({ error: 'not found' });
  });

  // Tradie adds a job by hand (e.g. from a voicemail or a chat on site).
  app.post('/api/jobs', async (req, res) => {
    const b = req.body || {};
    if (!b.details?.trim()) return res.status(400).json({ error: 'details required' });
    const { job } = await processEnquiry({
      source: 'manual',
      text: b.details,
      known: pickKnown(b),
    });
    const patch = {};
    if (PRIORITIES.includes(b.priority)) Object.assign(patch, { priority: b.priority, priority_score: PRIORITY_SCORE[b.priority] });
    if (b.scheduled_for) patch.scheduled_for = b.scheduled_for;
    if (b.estimated_value) patch.estimated_value = Number(b.estimated_value);
    res.status(201).json(updateJob(job.id, patch));
  });

  app.patch('/api/jobs/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getJob(id)) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const patch = {};
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
      patch.status = b.status;
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'bad priority' });
      Object.assign(patch, { priority: b.priority, priority_score: PRIORITY_SCORE[b.priority] });
    }
    for (const k of ['scheduled_for', 'notes', 'customer_name', 'customer_phone', 'customer_email', 'address', 'suburb', 'summary']) {
      if (b[k] !== undefined) patch[k] = String(b[k]);
    }
    if (b.estimated_value !== undefined) patch.estimated_value = b.estimated_value === '' ? null : Number(b.estimated_value);
    res.json(updateJob(id, patch));
  });

  // Run a pretend call or email through the real screening pipeline.
  app.post('/api/simulate', async (req, res) => {
    const b = req.body || {};
    if (!['phone', 'email'].includes(b.source) || !b.text?.trim()) {
      return res.status(400).json({ error: 'source (phone|email) and text required' });
    }
    const result = await processEnquiry({ source: b.source, text: b.text, from: b.from || '' }, { notifier });
    res.json(result);
  });

  app.get('/api/settings', (_req, res) => res.json(getSettings()));
  app.put('/api/settings', (req, res) => res.json(updateSettings(req.body || {})));
  app.get('/api/notifications', (_req, res) => res.json(listNotifications()));
  app.post('/api/digest', async (_req, res) => res.json(await sendDigest()));

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

function pickKnown(b) {
  const out = {};
  for (const k of ['customer_name', 'customer_phone', 'customer_email', 'address', 'suburb']) if (b[k]) out[k] = b[k];
  return out;
}

function basicAuth(req, res, next) {
  const pw = config.dashboardPassword;
  if (!pw) return next();
  const [, encoded] = (req.header('authorization') || '').split(' ');
  const supplied = encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
  if (supplied === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="Jobs"').status(401).send('Login required');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = createApp();
  startDigestScheduler();
  app.listen(config.port, () => {
    console.log(`Tradie Triage running on http://localhost:${config.port}`);
    console.log(`Claude triage: ${config.anthropic.enabled ? 'on' : 'off (using keyword rules)'}; Twilio: ${twilioConfigured() ? 'on' : 'off'}`);
  });
}
