// After-hours email screening. Point an inbound-email provider at
//   POST /webhooks/email?key=<EMAIL_INBOUND_KEY>
// Works with SendGrid Inbound Parse (multipart form), Mailgun Routes (form) and
// Postmark Inbound (JSON). Every email is triaged; when the business is after hours,
// the customer gets an auto-reply that matches the priority (if SendGrid sending is set up).

import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { processEnquiry } from './intake.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 } });

export function emailRouter({ notifier, mailer = sendAutoReply } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '10mb' }), express.urlencoded({ extended: false, limit: '10mb' }));

  r.post('/', checkKey, upload.any(), async (req, res) => {
    const email = normaliseInbound(req.body || {});
    if (!email.fromAddress && !email.text) return res.status(400).json({ error: 'no email content' });

    const text = `Subject: ${email.subject}\n\n${email.text}`.slice(0, 20000);
    const { job, notification, afterHours, duplicate } = await processEnquiry(
      {
        source: 'email',
        text,
        from: email.fromAddress,
        externalRef: email.messageId || undefined,
        known: { customer_name: email.fromName, customer_email: email.fromAddress },
      },
      { notifier },
    );
    if (!duplicate && afterHours && job.priority !== 'not_a_job' && email.fromAddress) {
      mailer(email, job, notification).catch((e) => console.error('[email] auto-reply failed', e.message));
    }
    res.json({ ok: true, job_id: job.id, priority: job.priority, notification, duplicate: Boolean(duplicate) });
  });
  return r;
}

function checkKey(req, res, next) {
  if (!config.email.inboundKey) return next();
  if (req.query.key !== config.email.inboundKey) return res.status(403).json({ error: 'bad key' });
  next();
}

export function normaliseInbound(b) {
  // Postmark JSON
  if (b.From || b.TextBody || b.FromFull) {
    return {
      fromAddress: b.FromFull?.Email || parseAddress(b.From).address,
      fromName: b.FromName || b.FromFull?.Name || parseAddress(b.From).name,
      subject: b.Subject || '',
      text: b.TextBody || b.StrippedTextReply || stripHtml(b.HtmlBody || ''),
      messageId: b.MessageID || '',
    };
  }
  // Mailgun
  if (b['body-plain'] || b.sender) {
    const p = parseAddress(b.from || b.sender);
    return {
      fromAddress: p.address,
      fromName: p.name,
      subject: b.subject || '',
      text: b['stripped-text'] || b['body-plain'] || '',
      messageId: b['Message-Id'] || '',
    };
  }
  // SendGrid Inbound Parse (and a plain {from, subject, text} shape for testing)
  const p = parseAddress(b.from);
  const idMatch = /^Message-ID:\s*(.+)$/im.exec(b.headers || '');
  return {
    fromAddress: p.address,
    fromName: p.name,
    subject: b.subject || '',
    text: b.text || stripHtml(b.html || ''),
    messageId: b.messageId || idMatch?.[1]?.trim() || '',
  };
}

export function parseAddress(raw = '') {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: '', address: String(raw).trim().toLowerCase() };
}

const stripHtml = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function sendAutoReply(email, job, notification) {
  const { sendgridApiKey, fromAddress } = config.email;
  if (!sendgridApiKey || !fromAddress) return;
  const name = config.business.tradieName;
  const next =
    job.priority === 'emergency'
      ? notification === 'sent'
        ? `We've flagged this as an emergency and ${name} has been alerted. If you haven't heard back within 30 minutes, please call us.`
        : `We've flagged this as an emergency. For the fastest response, please call us.`
      : job.priority === 'urgent'
        ? `We've marked this as urgent and ${name} will contact you first thing.`
        : `${name} will be in touch during business hours.`;
  const lines = [
    `Hi${email.fromName ? ' ' + email.fromName.split(' ')[0] : ''},`,
    '',
    `Thanks for contacting ${config.business.name}. We've received your message (job #${job.id}).`,
    next,
  ];
  if (job.safety_advice) lines.push('', `In the meantime: ${job.safety_advice}`);
  lines.push('', 'If anyone is in danger, call triple zero (000).', '', config.business.name);

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sendgridApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: email.fromAddress }] }],
      from: { email: fromAddress, name: config.business.name },
      subject: `Re: ${email.subject || 'Your enquiry'}`,
      content: [{ type: 'text/plain', value: lines.join('\n') }],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}`);
}
