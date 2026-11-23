// After-hours phone screening using Twilio Programmable Voice.
// Point your Twilio number's "A call comes in" webhook at POST /webhooks/voice/incoming.
//
// In business hours the call is forwarded to the tradie's mobile. After hours (or if the
// tradie doesn't answer) an automated assistant asks three questions, triages the answers,
// tells the caller what will happen next, and only then notifies the tradie by priority.

import express from 'express';
import twilio from 'twilio';
import { config } from './config.js';
import { getDb, getSettings } from './db.js';
import { isAfterHours } from './hours.js';
import { processEnquiry } from './intake.js';

const { VoiceResponse } = twilio.twiml;
const VOICE = { voice: 'Polly.Olivia', language: 'en-AU' };

const QUESTIONS = [
  { key: 'problem', prompt: 'Please describe the problem, and say if anything is leaking, sparking or smells of gas.' },
  { key: 'address', prompt: 'Thanks. What is the address, including the suburb?' },
  { key: 'name', prompt: 'And what is your name?' },
];

export function voiceRouter({ notifier } = {}) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(validateTwilio);

  r.post('/incoming', (req, res) => {
    const settings = getSettings();
    const vr = new VoiceResponse();
    const afterHours = isAfterHours(settings);
    if (!afterHours && settings.forwardCallsInHours && config.business.tradieMobile) {
      const dial = vr.dial({ timeout: 20, action: '/webhooks/voice/after-dial', callerId: req.body.From });
      dial.number(config.business.tradieMobile);
      return sendTwiml(res, vr);
    }
    startScreening(vr, req.body, afterHours);
    sendTwiml(res, vr);
  });

  // Tradie didn't pick up during business hours: screen the call instead.
  r.post('/after-dial', (req, res) => {
    const vr = new VoiceResponse();
    if (req.body.DialCallStatus === 'completed') {
      vr.hangup();
    } else {
      startScreening(vr, req.body, false, `${config.business.tradieName} can't get to the phone right now.`);
    }
    sendTwiml(res, vr);
  });

  r.post('/answer', async (req, res) => {
    const step = Number(req.query.step ?? 0);
    const tries = Number(req.query.tries ?? 0);
    const callSid = req.body.CallSid;
    const speech = (req.body.SpeechResult || '').trim();
    const vr = new VoiceResponse();

    const call = getCall(callSid, req.body.From);
    const answers = JSON.parse(call.answers);

    if (!speech && tries < 1) {
      vr.say(VOICE, "Sorry, I didn't catch that.");
      gather(vr, step, tries + 1);
      return sendTwiml(res, vr);
    }
    answers[QUESTIONS[step].key] = speech;
    saveCall(callSid, step + 1, answers);

    if (step + 1 < QUESTIONS.length) {
      gather(vr, step + 1, 0);
      return sendTwiml(res, vr);
    }

    // All questions answered: triage while the caller holds for a moment.
    const text = [
      `Problem: ${answers.problem || '(not given)'}`,
      `Address: ${answers.address || '(not given)'}`,
      `Name: ${answers.name || '(not given)'}`,
      `Caller ID: ${req.body.From || 'withheld'}`,
    ].join('\n');
    try {
      const { job, notification } = await processEnquiry(
        {
          source: 'phone',
          text,
          from: req.body.From,
          externalRef: callSid,
          known: { customer_name: answers.name, address: answers.address },
        },
        { timeoutMs: 8000, notifier },
      );
      getDb().prepare('UPDATE calls SET job_id = ? WHERE call_sid = ?').run(job.id, callSid);
      closingMessage(vr, job, notification);
    } catch (err) {
      console.error('[voice] triage failed', err);
      vr.say(VOICE, `Thanks. Your details have been saved and ${config.business.tradieName} will call you back.`);
    }
    vr.hangup();
    sendTwiml(res, vr);
  });

  return r;
}

function startScreening(vr, body, afterHours, intro) {
  const b = config.business;
  vr.say(
    VOICE,
    `Thanks for calling ${b.name}. ${intro ?? (afterHours ? "You've reached us after hours." : '')} ` +
      `I'm an automated assistant and I'll pass your details to ${b.tradieName}. ` +
      'If anyone is in danger, please hang up and call triple zero.',
  );
  gather(vr, 0, 0);
}

function gather(vr, step, tries) {
  const g = vr.gather({
    input: 'speech',
    language: 'en-AU',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true,
    action: `/webhooks/voice/answer?step=${step}&tries=${tries}`,
    method: 'POST',
    actionOnEmptyResult: true,
  });
  g.say(VOICE, QUESTIONS[step].prompt);
}

function closingMessage(vr, job, notification) {
  const s = getSettings();
  const name = config.business.tradieName;
  if (job.safety_advice) vr.say(VOICE, job.safety_advice);
  if (job.priority === 'emergency') {
    vr.say(
      VOICE,
      notification === 'sent'
        ? `I've marked this as an emergency and alerted ${name} now. They'll call you back as soon as possible.`
        : `I've marked this as an emergency. ${name} will get it first thing.`,
    );
    if (s.calloutFee) vr.say(VOICE, `Please note, there is a ${s.calloutFee}.`);
  } else if (job.priority === 'urgent') {
    vr.say(
      VOICE,
      notification === 'sent'
        ? `I've passed this on to ${name} as urgent. They'll be in touch shortly.`
        : `I've marked this as urgent. ${name} will call you first thing in the morning.`,
    );
  } else if (job.priority === 'routine') {
    vr.say(VOICE, `Thanks, I've logged your job. ${name} will be in touch during business hours.`);
  } else {
    vr.say(VOICE, 'Thanks for your call.');
  }
  vr.say(VOICE, 'Goodbye.');
}

// ---------- helpers ----------

function getCall(callSid, from) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO calls (call_sid, from_number) VALUES (?, ?)').run(callSid, from ?? null);
  return db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);
}

function saveCall(callSid, step, answers) {
  getDb().prepare('UPDATE calls SET step = ?, answers = ? WHERE call_sid = ?').run(step, JSON.stringify(answers), callSid);
}

function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

/** Reject webhooks that weren't signed by Twilio (when a token and PUBLIC_URL are set). */
function validateTwilio(req, res, next) {
  const { authToken, validateSignatures } = config.twilio;
  if (!validateSignatures || !authToken || !config.publicUrl) return next();
  const url = config.publicUrl.replace(/\/$/, '') + req.originalUrl;
  const ok = twilio.validateRequest(authToken, req.header('X-Twilio-Signature') || '', url, req.body || {});
  if (!ok) return res.status(403).send('Invalid Twilio signature');
  next();
}
