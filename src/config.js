// All configuration comes from environment variables so nothing secret lives in the repo.
// See .env.example for the full list.

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: env.PUBLIC_URL || '', // e.g. https://jobs.example.com.au (needed for Twilio signature checks)
  dbPath: env.DB_PATH || 'data/tradie.db',
  dashboardPassword: env.DASHBOARD_PASSWORD || '',

  business: {
    name: env.BUSINESS_NAME || "Sam's Plumbing",
    tradieName: env.TRADIE_NAME || 'Sam',
    trade: env.TRADE || 'plumber', // plumber | electrician | other trade, used in the triage prompt
    timezone: env.TIMEZONE || 'Australia/Sydney',
    serviceArea: env.SERVICE_AREA || '', // free text, e.g. "Inner West and Eastern Suburbs, Sydney"
    tradieMobile: env.TRADIE_MOBILE || '', // E.164, e.g. +61412345678
    tradieEmail: env.TRADIE_EMAIL || '',
  },

  anthropic: {
    model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    enabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  },

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    fromNumber: env.TWILIO_FROM_NUMBER || '', // your Twilio AU number, E.164
    validateSignatures: env.TWILIO_VALIDATE_SIGNATURES !== 'false',
  },

  email: {
    // Shared secret appended to the inbound webhook URL: /webhooks/email?key=...
    inboundKey: env.EMAIL_INBOUND_KEY || '',
    // Optional: SendGrid API key to send auto-replies to customers who email
    sendgridApiKey: env.SENDGRID_API_KEY || '',
    fromAddress: env.EMAIL_FROM || '',
  },

  ntfyTopic: env.NTFY_TOPIC || '', // optional free push notifications via https://ntfy.sh
};

export const twilioConfigured = () =>
  Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber);
