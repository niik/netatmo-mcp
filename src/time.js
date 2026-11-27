// Time-zone helpers. Stations report a tz name (e.g. "Europe/Stockholm");
// dates from the user are read, and timestamps shown, in that zone.

const fmtCache = new Map();
function partsIn(tz, ms) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
function offsetAt(tz, ms) {
  const p = partsIn(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Unix seconds for a wall-clock time in `tz`. */
export function zonedToUnix(tz, y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - offsetAt(tz, guess);
  ms = guess - offsetAt(tz, ms); // second pass settles DST edges
  return Math.floor(ms / 1000);
}

/**
 * Parse a user-supplied date/time into unix seconds.
 * "YYYY-MM-DD" → start of that day in `tz` (or end of day with endOfDay);
 * "YYYY-MM-DDTHH:mm[:ss]" without offset → wall time in `tz`;
 * anything with Z/±hh:mm → that instant.
 */
export function parseDate(input, tz, { endOfDay = false } = {}) {
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const start = zonedToUnix(tz, +m[1], +m[2], +m[3]);
    if (!endOfDay) return start;
    const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return zonedToUnix(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return zonedToUnix(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Can't parse date "${input}". Use YYYY-MM-DD or an ISO 8601 date-time.`);
  return Math.floor(ms / 1000);
}

const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:mm" (or just the date) for unix seconds in `tz`. */
export function formatTime(unix, tz, { dateOnly = false } = {}) {
  if (unix == null || !Number.isFinite(Number(unix))) return "–";
  const p = partsIn(tz, Number(unix) * 1000);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return dateOnly ? date : `${date} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
