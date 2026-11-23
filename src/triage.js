// Evaluates an incoming enquiry (call transcript or email) and decides its priority
// BEFORE the tradie is notified. Uses Claude when an API key is configured, and a
// keyword rule set otherwise (or if the API call fails), so screening never stops.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

export const PRIORITIES = ['emergency', 'urgent', 'routine', 'not_a_job'];
export const PRIORITY_SCORE = { emergency: 300, urgent: 200, routine: 100, not_a_job: 0 };

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'priority', 'category', 'summary', 'reasoning', 'safety_advice',
    'customer_name', 'customer_phone', 'address', 'suburb', 'in_service_area',
  ],
  properties: {
    priority: { type: 'string', enum: PRIORITIES },
    category: { type: 'string', description: 'Short job type, e.g. "burst pipe", "no power", "blocked drain"' },
    summary: { type: 'string', description: 'One sentence the tradie can read on a lock screen' },
    reasoning: { type: 'string', description: 'Why this priority, in one or two sentences' },
    safety_advice: {
      type: 'string',
      description: 'Immediate safety step for the customer, or empty string if none is needed',
    },
    customer_name: { type: 'string', description: 'Empty string if not given' },
    customer_phone: { type: 'string', description: 'Empty string if not given' },
    address: { type: 'string', description: 'Street address as given, empty string if not given' },
    suburb: { type: 'string', description: 'Suburb or town, empty string if not given' },
    in_service_area: { type: 'string', enum: ['yes', 'no', 'unknown'] },
  },
};

function systemPrompt() {
  const b = config.business;
  return `You screen after-hours enquiries for ${b.name}, an Australian sole-trader ${b.trade}.
Your job is to decide how urgently ${b.tradieName} needs to know about each enquiry, before they are notified.

Priorities:
- emergency: risk to life, safety or serious property damage that cannot wait until morning. Examples: gas smell, sparking or burning smell from wiring or switchboard, electric shock, exposed live wires, water actively flooding or a burst pipe that cannot be isolated, sewage overflowing inside the home, total loss of power or water to a home with a medical or vulnerable occupant, no hot water combined with a leaking or venting hot water unit.
- urgent: needs attention within about 24 hours but is contained. Examples: burst pipe already isolated at the mains, only toilet blocked, partial power loss, hot water system failed, leak contained in a bucket, a business unable to trade.
- routine: can be booked in normal hours. Quotes, renovations, dripping taps, new power points, installs, maintenance, general questions.
- not_a_job: spam, sales calls, wrong numbers, job seekers, or messages with no service request.

Rules:
- Judge by the situation described, not the customer's own words like "urgent" or "ASAP". A dripping tap is routine even if called urgent.
- When the situation could be dangerous and details are unclear, choose the higher priority.
- safety_advice must be short and practical (e.g. turn the water off at the mains, switch off at the switchboard only if safe, leave the house and call the gas emergency line). If anyone may be hurt or in danger, tell them to call triple zero (000). Never give repair instructions.
- Use Australian spelling and terms.
- Only extract contact details that actually appear in the enquiry. Do not invent them.${
    b.serviceArea ? `\n- Service area: ${b.serviceArea}. Set in_service_area accordingly; unknown if no location is given.` : '\n- No service area is configured; set in_service_area to "unknown".'
  }`;
}

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

/**
 * @param {{source: 'phone'|'email'|'manual', text: string, from?: string}} enquiry
 * @returns {Promise<object>} triage result with a `triaged_by` field
 */
export async function triage(enquiry, { timeoutMs } = {}) {
  if (config.anthropic.enabled) {
    try {
      return await triageWithClaude(enquiry, timeoutMs);
    } catch (err) {
      console.error('[triage] Claude triage failed, using rules:', err?.message ?? err);
    }
  }
  return triageWithRules(enquiry);
}

async function triageWithClaude({ source, text, from }, timeoutMs) {
  // A caller on the line can't wait long, so phone triage passes a short timeout
  // and falls back to the rules if Claude doesn't answer in time.
  const requestOptions = timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined;
  const response = await getClient().beta.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    // Fall back to another model automatically if a request is declined.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Classification: low effort keeps it quick while a caller is waiting.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: TRIAGE_SCHEMA },
    },
    system: systemPrompt(),
    messages: [
      {
        role: 'user',
        content: `Source: ${source}${from ? `\nFrom: ${from}` : ''}\n\n<enquiry>\n${text}\n</enquiry>`,
      },
    ],
  }, requestOptions);

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    throw new Error(`stop_reason=${response.stop_reason}`);
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block in response');
  const result = JSON.parse(textBlock.text);
  if (!PRIORITIES.includes(result.priority)) throw new Error(`bad priority ${result.priority}`);
  return { ...result, triaged_by: 'claude' };
}

// ---------- Rule-based fallback ----------

const RULES = [
  {
    priority: 'emergency',
    category: 'gas leak',
    words: ['gas leak', 'smell gas', 'smell of gas', 'smells like gas', 'gas smell'],
    advice: 'Leave the house, do not use switches or flames, and call your gas distributor’s emergency line. If anyone is unwell, call 000.',
  },
  {
    priority: 'emergency',
    category: 'electrical hazard',
    words: ['spark', 'sparking', 'burning smell', 'smoke', 'electric shock', 'got a shock', 'live wire', 'exposed wire', 'switchboard on fire', 'melting', 'fire'],
    advice: 'Keep everyone away. Only switch off at the switchboard if it is safe to do so. If there is fire or anyone is hurt, call 000.',
  },
  {
    priority: 'emergency',
    category: 'flooding / burst pipe',
    words: ['burst pipe', 'pipe burst', 'flooding', 'flooded', 'water everywhere', 'gushing', 'pouring through the ceiling', 'ceiling collapsing'],
    advice: 'Turn the water off at the mains (usually near the front boundary or water meter). Keep clear of wet power points and switches.',
  },
  {
    priority: 'emergency',
    category: 'sewage overflow',
    words: ['sewage', 'sewerage overflow', 'raw sewage', 'overflowing toilet inside'],
    advice: 'Stop using all toilets, sinks and showers, and keep people and pets away from the overflow.',
  },
  {
    priority: 'urgent',
    category: 'power outage',
    words: ['no power', 'power out', 'lost power', 'tripping', 'keeps tripping', 'safety switch'],
    advice: 'Check with your neighbours or the network outage page in case it is a street-wide outage.',
  },
  {
    priority: 'urgent',
    category: 'hot water',
    words: ['no hot water', 'hot water system', 'hot water unit', 'hws'],
    advice: '',
  },
  {
    priority: 'urgent',
    category: 'blocked drain / toilet',
    words: ['blocked toilet', 'toilet blocked', 'blocked drain', 'drain blocked', 'overflowing'],
    advice: 'Avoid using the affected fixture until it is fixed.',
  },
  {
    priority: 'urgent',
    category: 'leak',
    words: ['leak', 'leaking', 'water damage'],
    advice: 'If you can, turn the water off at the mains or at the fixture’s isolation tap.',
  },
  {
    priority: 'not_a_job',
    category: 'not a job',
    words: ['seo', 'marketing services', 'unsubscribe', 'are you hiring', 'apprenticeship', 'wrong number', 'business loan', 'google listing'],
    advice: '',
  },
];

export function triageWithRules({ text }) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  const match = RULES.find((r) => r.words.some((w) => lower.includes(w)));
  const priority = match?.priority ?? (lower.trim() ? 'routine' : 'not_a_job');
  // Pull "Problem: / Address: / Name:" lines out of phone transcripts when present.
  const field = (k) => (new RegExp(`^${k}:\\s*(.+)$`, 'im').exec(text || '')?.[1] ?? '').replace(/\(not given\)/, '').trim();
  const problem = field('Problem') || field('Subject') || String(text || '');
  const firstSentence = problem.split(/(?<=[.!?])\s|\n/)[0].slice(0, 160);
  return {
    priority,
    category: match?.category ?? 'general enquiry',
    summary: firstSentence ? firstSentence[0].toUpperCase() + firstSentence.slice(1) : 'Empty enquiry',
    reasoning: match ? `Matched keyword rule for "${match.category}".` : 'No urgent keywords found.',
    safety_advice: match?.advice ?? '',
    customer_name: field('Name'),
    customer_phone: (text.match(/(\+?61|0)[2-478](?:[ -]?\d){8}/) || [''])[0].replace(/[ -]/g, ''),
    address: field('Address'),
    suburb: '',
    in_service_area: 'unknown',
    triaged_by: 'rules',
  };
}
