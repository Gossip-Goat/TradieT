import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let db;

const DEFAULT_SETTINGS = {
  // Business hours per weekday (0 = Sunday). null = closed all day.
  hours: {
    0: null,
    1: ['07:00', '17:00'],
    2: ['07:00', '17:00'],
    3: ['07:00', '17:00'],
    4: ['07:00', '17:00'],
    5: ['07:00', '17:00'],
    6: ['08:00', '12:00'],
  },
  // During business hours, forward calls straight to the tradie instead of screening.
  forwardCallsInHours: true,
  // Force screening on (e.g. on holiday or on a big job). Overrides business hours.
  screeningAlwaysOn: false,
  // What the tradie wants to be woken for after hours.
  wakeFor: 'emergency', // 'emergency' | 'urgent' | 'none'
  // When routine after-hours jobs are delivered as a digest.
  digestTime: '06:30',
  // Ring the tradie (not just SMS) for emergencies.
  callForEmergencies: true,
  calloutFee: '', // shown to emergency callers, e.g. "$180 after-hours call-out"
};

export function getDb() {
  if (db) return db;
  if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,              -- phone | email | manual
      status TEXT NOT NULL DEFAULT 'new',-- new | accepted | scheduled | in_progress | done | declined
      priority TEXT NOT NULL DEFAULT 'routine', -- emergency | urgent | routine | not_a_job
      priority_score INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      summary TEXT,
      reasoning TEXT,
      safety_advice TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      address TEXT,
      suburb TEXT,
      details TEXT,                      -- raw transcript / email body
      triaged_by TEXT,                   -- claude | rules
      after_hours INTEGER NOT NULL DEFAULT 0,
      notified_at TEXT,
      notify_channel TEXT,
      scheduled_for TEXT,
      estimated_value REAL,
      notes TEXT,
      external_ref TEXT                  -- CallSid or Message-ID, for de-duplication
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_external_ref ON jobs(external_ref) WHERE external_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS calls (
      call_sid TEXT PRIMARY KEY,
      from_number TEXT,
      step INTEGER NOT NULL DEFAULT 0,
      answers TEXT NOT NULL DEFAULT '{}',
      job_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      channel TEXT, status TEXT, body TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) s[r.key] = JSON.parse(r.value);
  return s;
}

export function updateSettings(patch) {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

const JOB_FIELDS = [
  'source', 'status', 'priority', 'priority_score', 'category', 'summary', 'reasoning', 'safety_advice',
  'customer_name', 'customer_phone', 'customer_email', 'address', 'suburb', 'details', 'triaged_by',
  'after_hours', 'notified_at', 'notify_channel', 'scheduled_for', 'estimated_value', 'notes', 'external_ref',
];

export function createJob(job) {
  const fields = JOB_FIELDS.filter((f) => job[f] !== undefined);
  const sql = `INSERT INTO jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`;
  const res = getDb().prepare(sql).run(...fields.map((f) => normalise(job[f])));
  return getJob(Number(res.lastInsertRowid));
}

export function updateJob(id, patch) {
  const fields = JOB_FIELDS.filter((f) => patch[f] !== undefined);
  if (!fields.length) return getJob(id);
  const sql = `UPDATE jobs SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  getDb().prepare(sql).run(...fields.map((f) => normalise(patch[f])), id);
  return getJob(id);
}

export const getJob = (id) => getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
export const getJobByRef = (ref) => getDb().prepare('SELECT * FROM jobs WHERE external_ref = ?').get(ref);

export function listJobs({ status, priority } = {}) {
  const where = [];
  const args = [];
  if (status === 'open') where.push("status NOT IN ('done','declined')");
  else if (status) { where.push('status = ?'); args.push(status); }
  if (priority) { where.push('priority = ?'); args.push(priority); }
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY priority_score DESC, created_at ASC`;
  return getDb().prepare(sql).all(...args);
}

export function logNotification(n) {
  getDb()
    .prepare('INSERT INTO notifications (job_id, channel, status, body, error) VALUES (?, ?, ?, ?, ?)')
    .run(n.job_id ?? null, n.channel, n.status, n.body ?? null, n.error ?? null);
}

export const listNotifications = (limit = 50) =>
  getDb().prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit);

function normalise(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
