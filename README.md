# Tradie Triage

A job manager for Australian sole traders (plumbers, electricians and other trades) with an
**after-hours phone and email screening service**. Every enquiry that comes in after hours is
evaluated and given a priority *before* the tradie hears about it. The tradie is then notified
in a way that matches that priority:

| Priority | Examples | After hours, the tradie gets… |
|---|---|---|
| **Emergency** | gas smell, sparking switchboard, burst pipe that won't isolate, sewage inside | SMS + phone call + push, straight away |
| **Urgent** | no hot water, blocked only toilet, isolated leak, partial power loss | held for the morning digest (or sent now if "wake me for urgent" is on) |
| **Routine** | quotes, installs, dripping taps | held for the morning digest |
| **Not a job** | spam, sales calls, job seekers | filtered out, never sent |

In business hours, calls are forwarded to the tradie's mobile. If they don't pick up, the
screening assistant takes over.

## How it works

```
 Customer calls ─► Twilio ─► /webhooks/voice ─┐
                                              ├─► triage (Claude, or keyword rules) ─► job saved ─► notify by priority
 Customer emails ─► SendGrid/Postmark/Mailgun ┘                                                       │
                     └─► /webhooks/email                                       SMS / call / push ◄────┘
                                                                               or 6:30am digest
```

**Phone screening**: an automated voice (Australian English) tells the caller to ring 000 if
anyone is in danger, then asks three questions: what's the problem, what's the address, and
what's your name. The answers are triaged while the caller holds for a few seconds. The caller
hears any safety advice (e.g. "turn the water off at the mains") and what happens next
("I've alerted Sam now" or "Sam will call you first thing"). Then the tradie is notified.

**Email screening**: inbound emails are triaged the same way. After hours, the customer gets an
auto-reply matching the priority (optional, needs SendGrid).

**Triage**: uses Claude (`claude-opus-5-5`, low effort, structured JSON output) with a prompt
tuned for Australian trade emergencies. If no API key is set, the API is slow (phone calls
give it 8 seconds) or the call fails, a keyword rule set takes over, so screening never stops.

**Dashboard** (mobile-friendly, at `/`): jobs sorted by priority, one-tap call/email/map,
accept → schedule → start → done, change priority, add jobs by hand, a "Test screening" tab
that runs a pretend call or email through the real pipeline, business-hours settings, and a
log of every notification sent.

## Run it locally

Needs Node 22.13 or later. No other services required to try it.

```bash
npm install
npm start            # http://localhost:3000
npm test             # 8 offline tests: triage, hours, phone flow, email webhooks, API
```

Without any keys it runs on keyword triage and just logs notifications. Open **Test screening**
to try it.

## What needs Tom's accounts

| Service | What for | Needed? | What to set |
|---|---|---|---|
| **Anthropic API** (console.anthropic.com) | AI triage | Strongly recommended | `ANTHROPIC_API_KEY` |
| **Twilio** (twilio.com) | Australian phone number, call screening, SMS and call alerts | Yes, for phone screening and SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| **Inbound email**: SendGrid Inbound Parse, Postmark or Mailgun | Receive enquiry emails as webhooks | Yes, for email screening | `EMAIL_INBOUND_KEY` |
| **SendGrid** | Auto-reply to customers who email | Optional | `SENDGRID_API_KEY`, `EMAIL_FROM` |
| **ntfy** (ntfy.sh app) | Free push notifications to the tradie's phone | Optional | `NTFY_TOPIC` |
| **A host** (Render, Railway, Fly.io, a VPS) | Run the app at a public HTTPS address | Yes | `PUBLIC_URL`, `DASHBOARD_PASSWORD`, plus a persistent disk for `data/` |

Copy `.env.example` to `.env`, fill it in and start with `node --env-file=.env src/server.js`.

### Twilio setup
1. Buy an Australian number with Voice and SMS. Australian numbers need a regulatory bundle
   (proof of business address) before Twilio will issue them.
2. Number → Voice configuration → "A call comes in": Webhook, `POST {PUBLIC_URL}/webhooks/voice/incoming`.
3. Either give customers the Twilio number, or set up conditional call forwarding on the
   tradie's existing mobile (busy / no answer / after hours) to the Twilio number.

### Email setup
Point the provider's inbound webhook at `POST {PUBLIC_URL}/webhooks/email?key={EMAIL_INBOUND_KEY}`.
For example, with SendGrid Inbound Parse, add an MX record for `jobs.yourdomain.com.au` and
forward the business email there, or use the provider's own receiving address.

## Project layout

```
src/server.js   Express app, dashboard API, starts the morning digest timer
src/intake.js   The shared pipeline: triage -> save job -> notify by priority
src/triage.js   Claude triage + keyword fallback
src/voice.js    Twilio call screening (TwiML)
src/email.js    Inbound email webhook (SendGrid / Postmark / Mailgun) + auto-reply
src/notify.js   SMS, call, push, morning digest
src/hours.js    Business hours and "should we wake the tradie" rules
src/db.js       SQLite (built into Node), jobs, calls, settings, notification log
public/         Dashboard (single page, no build step)
```

## Not in this MVP yet
- Multiple tradies / staff accounts (one business per deployment today)
- Quoting, invoicing and calendar sync (e.g. Xero, Google Calendar)
- A natural back-and-forth AI voice agent; the call uses three fixed questions, which is cheaper and more predictable
- SMS enquiries from customers (easy to add on the same Twilio number)
