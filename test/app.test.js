import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Isolated, offline test setup: in-memory DB, rule-based triage, no real notifications.
process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.TIMEZONE = 'Australia/Sydney';

const { triageWithRules } = await import('../src/triage.js');
const { isAfterHours, shouldNotifyNow } = await import('../src/hours.js');
const { processEnquiry } = await import('../src/intake.js');
const { updateSettings, getSettings, getJob } = await import('../src/db.js');
const { sendDigest } = await import('../src/notify.js');
const { createApp } = await import('../src/server.js');
const { normaliseInbound } = await import('../src/email.js');

// Monday 23 Nov 2026, 11pm Sydney (AEDT = UTC+11) -> 12:00 UTC
const MONDAY_NIGHT = new Date('2026-11-23T12:00:00Z');
// Monday 23 Nov 2026, 10am Sydney -> 23:00 UTC Sunday
const MONDAY_MORNING = new Date('2026-11-22T23:00:00Z');

const sent = [];
const fakeNotifier = async (job) => { sent.push(job.id); };

let server, base;
before(async () => {
  updateSettings({ screeningAlwaysOn: true, wakeFor: 'emergency' });
  server = createApp({ notifier: fakeNotifier }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('rules triage spots emergencies, urgent jobs, routine work and spam', () => {
  assert.equal(triageWithRules({ text: 'I can smell gas in the kitchen' }).priority, 'emergency');
  assert.equal(triageWithRules({ text: 'Switchboard is sparking' }).priority, 'emergency');
  assert.equal(triageWithRules({ text: 'Burst pipe, water everywhere' }).priority, 'emergency');
  assert.equal(triageWithRules({ text: 'No hot water since this morning' }).priority, 'urgent');
  assert.equal(triageWithRules({ text: 'Quote for a new bathroom vanity please' }).priority, 'routine');
  assert.equal(triageWithRules({ text: 'We offer SEO for tradies' }).priority, 'not_a_job');
  assert.equal(triageWithRules({ text: 'call me on 0412 345 678' }).customer_phone, '0412345678');
});

test('business hours are worked out in the tradie’s time zone', () => {
  const s = { ...getSettings(), screeningAlwaysOn: false };
  assert.equal(isAfterHours(s, MONDAY_NIGHT), true);
  assert.equal(isAfterHours(s, MONDAY_MORNING), false);
  assert.equal(isAfterHours({ ...s, screeningAlwaysOn: true }, MONDAY_MORNING), true);
});

test('after hours: only what the tradie wants to be woken for gets through', () => {
  const s = { wakeFor: 'emergency' };
  assert.equal(shouldNotifyNow('emergency', s, true), true);
  assert.equal(shouldNotifyNow('urgent', s, true), false);
  assert.equal(shouldNotifyNow('routine', s, true), false);
  assert.equal(shouldNotifyNow('urgent', { wakeFor: 'urgent' }, true), true);
  assert.equal(shouldNotifyNow('routine', s, false), true);
  assert.equal(shouldNotifyNow('not_a_job', s, false), false);
});

test('screening triages before notifying, holds routine jobs, filters spam, then digests', async () => {
  sent.length = 0;
  const emergency = await processEnquiry({ source: 'email', text: 'Water pouring through the ceiling, burst pipe!', from: 'a@x.com' }, { notifier: fakeNotifier });
  const routine = await processEnquiry({ source: 'email', text: 'Can I get a quote for a new tap?', from: 'b@x.com' }, { notifier: fakeNotifier });
  const spam = await processEnquiry({ source: 'email', text: 'Boost your Google listing with our SEO', from: 'c@x.com' }, { notifier: fakeNotifier });

  assert.equal(emergency.job.priority, 'emergency');
  assert.equal(emergency.notification, 'sent');
  assert.deepEqual(sent, [emergency.job.id]);
  assert.equal(routine.notification, 'held');
  assert.equal(spam.notification, 'filtered');
  assert.equal(spam.job.status, 'declined');

  const smsBodies = [];
  const digest = await sendDigest({ transport: { sms: async (_to, b) => smsBodies.push(b), push: async () => false } });
  assert.ok(digest.count >= 1);
  assert.match(smsBodies[0], /quote for a new tap/);
  assert.equal(getJob(routine.job.id).notify_channel, 'digest');
});

test('phone screening asks three questions, triages, tells the caller and saves the job', async () => {
  sent.length = 0;
  const post = (path, body) =>
    fetch(base + path, { method: 'POST', body: new URLSearchParams(body) }).then((r) => r.text());
  const call = { CallSid: 'CA-test-1', From: '+61400111222' };

  const greeting = await post('/webhooks/voice/incoming', call);
  assert.match(greeting, /triple zero/);
  assert.match(greeting, /<Gather[^>]*step=0/);

  assert.match(await post('/webhooks/voice/answer?step=0&tries=0', { ...call, SpeechResult: 'My switchboard is sparking and smells like burning' }), /address/);
  assert.match(await post('/webhooks/voice/answer?step=1&tries=0', { ...call, SpeechResult: '5 Smith Street Marrickville' }), /your name/);
  const closing = await post('/webhooks/voice/answer?step=2&tries=0', { ...call, SpeechResult: 'Jo' });

  assert.match(closing, /emergency/);
  assert.match(closing, /<Hangup/);
  assert.equal(sent.length, 1);
  const job = await fetch(`${base}/api/jobs/${sent[0]}`).then((r) => r.json());
  assert.equal(job.priority, 'emergency');
  assert.equal(job.customer_name, 'Jo');
  assert.equal(job.customer_phone, '+61400111222');
  assert.equal(job.address, '5 Smith Street Marrickville');

  // Twilio retries must not create a second job
  await post('/webhooks/voice/answer?step=2&tries=0', { ...call, SpeechResult: 'Jo' });
  assert.equal(sent.length, 1);
});

test('silence on the phone gets one retry, then moves on', async () => {
  const call = { CallSid: 'CA-test-2', From: '+61400999888' };
  const r1 = await fetch(base + '/webhooks/voice/answer?step=0&tries=0', { method: 'POST', body: new URLSearchParams({ ...call, SpeechResult: '' }) }).then((r) => r.text());
  assert.match(r1, /didn't catch that/);
  assert.match(r1, /tries=1/);
});

test('email webhook accepts Postmark JSON and SendGrid-style form posts', async () => {
  const pm = await fetch(base + '/webhooks/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ From: 'Kim Lee <kim@example.com>', FromName: 'Kim Lee', Subject: 'No hot water', TextBody: 'Our hot water system died tonight', MessageID: 'pm-1' }),
  }).then((r) => r.json());
  assert.equal(pm.priority, 'urgent');

  const form = new FormData();
  form.set('from', '"Sam P" <sam@example.com>');
  form.set('subject', 'Quote');
  form.set('text', 'Looking for a quote on 4 new downlights');
  const sg = await fetch(base + '/webhooks/email', { method: 'POST', body: form }).then((r) => r.json());
  assert.equal(sg.priority, 'routine');
  const job = await fetch(`${base}/api/jobs/${sg.job_id}`).then((r) => r.json());
  assert.equal(job.customer_email, 'sam@example.com');
  assert.equal(job.customer_name, 'Sam P');

  assert.equal(normaliseInbound({ sender: 'x@y.com', 'body-plain': 'hi', subject: 's' }).fromAddress, 'x@y.com');
});

test('dashboard API: add, reprioritise and progress a job', async () => {
  const created = await fetch(base + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ details: 'Replace laundry tap', customer_name: 'Ash', priority: 'routine', estimated_value: 220 }),
  }).then((r) => r.json());
  assert.equal(created.source, 'manual');
  assert.equal(created.estimated_value, 220);

  const patched = await fetch(`${base}/api/jobs/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'urgent', status: 'scheduled', scheduled_for: 'Tue 9am' }),
  }).then((r) => r.json());
  assert.equal(patched.priority, 'urgent');
  assert.equal(patched.priority_score, 200);
  assert.equal(patched.status, 'scheduled');

  const open = await fetch(base + '/api/jobs?status=open').then((r) => r.json());
  const scores = open.map((j) => j.priority_score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'open jobs sorted by priority');
});
