import { config } from './config.js';

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local weekday (0-6) and "HH:MM" for a Date in the business time zone. */
export function localParts(date = new Date(), timezone = config.business.timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: DAYS[parts.weekday], time: `${parts.hour}:${parts.minute}` };
}

export function isAfterHours(settings, date = new Date(), timezone = config.business.timezone) {
  if (settings.screeningAlwaysOn) return true;
  const { day, time } = localParts(date, timezone);
  const window = settings.hours?.[day];
  if (!window) return true;
  const [open, close] = window;
  return !(time >= open && time < close);
}

/** Should the tradie be interrupted right now for a job of this priority? */
export function shouldNotifyNow(priority, settings, afterHours) {
  if (priority === 'not_a_job') return false;
  if (!afterHours) return true; // in hours: everything is sent straight away
  if (priority === 'emergency') return settings.wakeFor !== 'none';
  if (priority === 'urgent') return settings.wakeFor === 'urgent';
  return false; // routine after hours waits for the morning digest
}

export function formatLocal(isoOrDate, timezone = config.business.timezone) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate.replace(' ', 'T') + 'Z') : isoOrDate;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(d);
}
