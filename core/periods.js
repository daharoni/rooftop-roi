/* =============================================================================
 * core/periods.js - THE one TOU-period lookup: holidays, day type, season, schedule
 * row, schedule_overrides.  Imported by core/tariff.js (periodAt, exportRateAt) and by
 * core/engine.js (prepare's day types, buildRates' period codes), so the engine and
 * the tariff library can never disagree about which period an hour is in.
 *
 * Plain ES module, no dependencies, no DOM.  core/bundle-for-worker.mjs concatenates it
 * into app/worker-bundle.js ahead of engine.js (it is published as `TouPeriods`).
 *
 * Holidays bill the WEEKEND schedule.  The eight: New Year's Day, Presidents' Day,
 * Memorial Day, Independence Day, Labor Day, Veterans Day, Thanksgiving, Christmas.
 * A fixed-date holiday that falls on a SUNDAY is also observed on the Monday after, so
 * a Monday can bill as a weekend.  A holiday that falls on a SATURDAY is NOT moved to
 * the Friday before.  That is SDG&E's rule, not the federal one, and only SDG&E's is
 * quoted in this repo: "When any holiday listed above falls on Sunday, the following
 * Monday will be recognized as an off-peak period. No change will be made for holidays
 * falling on Saturday" (SDG&E Electric Rule 1; data/tariffs/sdge.json meta.notes).
 * sce.json lists the holidays with no observance text, and pge.json quotes none, so
 * SCE and PG&E are ASSUMED to follow the same rule.  pge.json's export-matrix note
 * counts 111 weekend/holiday days in 2026 (104 weekend days + the seven weekday
 * holidays, Saturday July 4 left unshifted), which agrees with "no Saturday shift" but
 * does not test the Sunday rule, since no 2026 holiday falls on a Sunday.  (Until
 * 2026-10 core/tariff.js also shifted Saturday holidays to Friday while core/engine.js
 * shifted nothing; this module replaced both.)
 * ========================================================================== */

/** Day of month of the n-th `weekday` (0 = Sunday) of `month` (1-12). */
export function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
/** Day of month of the last `weekday` of `month` (1-12). */
export function lastWeekday(year, month, weekday) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
  return days - ((last - weekday + 7) % 7);
}
/** 0 = Sunday .. 6 = Saturday, for a calendar date (no time zone involved). */
export function dayOfWeek(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The holidays for one year, as a Set of "y-m-d" keys (month and day unpadded).
 * A Sunday fixed-date holiday adds its Monday; the Sunday entry itself is harmless (it
 * is a weekend day anyway).  Never crosses a year boundary: Jan 1 -> Jan 2, Dec 25 ->
 * Dec 26.  Returns a fresh Set.
 */
export function holidaysForYear(year) {
  const s = new Set();
  const add = (m, d) => s.add(year + "-" + m + "-" + d);
  const addObserved = (m, d) => {
    add(m, d);
    // Sunday -> the Monday after.  Saturday -> no change (see the header).
    if (dayOfWeek(year, m, d) === 0) add(m, d + 1);
  };
  addObserved(1, 1);                                  // New Year's Day
  add(2, nthWeekday(year, 2, 1, 3));                  // Presidents' Day
  add(5, lastWeekday(year, 5, 1));                    // Memorial Day
  addObserved(7, 4);                                  // Independence Day
  add(9, nthWeekday(year, 9, 1, 1));                  // Labor Day
  addObserved(11, 11);                                // Veterans Day
  add(11, nthWeekday(year, 11, 4, 4));                // Thanksgiving
  addObserved(12, 25);                                // Christmas
  return s;
}

const holidayCache = new Map();
/** True when y-m-d (m 1-12) is one of the holidays (actual or observed date). */
export function isHoliday(y, m, d) {
  let s = holidayCache.get(y);
  if (!s) { s = holidaysForYear(y); holidayCache.set(y, s); }
  return s.has(y + "-" + m + "-" + d);
}

/** True when the WEEKEND schedule applies: Saturday, Sunday, or a holiday. */
export function billsAsWeekend(y, m, d, dow) {
  const w = dow === undefined ? dayOfWeek(y, m, d) : dow;
  return w === 0 || w === 6 || isHoliday(y, m, d);
}

/** "summer" or "winter" for a plan and a month (1-12). */
export function seasonOf(plan, month) {
  const months = (plan && plan.summer_months) || [];
  return months.indexOf(+month) >= 0 ? "summer" : "winter";
}

/**
 * The period a plan is in for (month 1-12, weekend?, hour 0-23): the season's schedule
 * row (a missing weekend row reads the weekday one), then the plan's month-scoped
 * `schedule_overrides`, last match wins.  The summer/winter split cannot express a
 * window that covers only part of a season - SDG&E EV-TOU-2's March/April weekday
 * 10am-2pm super-off-peak is the live example - hence the overrides.
 * Throws on a plan whose schedule does not resolve: a miss is a bug, not a default.
 */
export function periodFor(plan, month, weekend, hour) {
  const season = seasonOf(plan, month);
  const dayType = weekend ? "weekend" : "weekday";
  const bySeason = plan.schedule[season];
  if (!bySeason) throw new Error("tariff: plan " + plan.id + " has no " + season + " schedule");
  const row = bySeason[dayType] || bySeason.weekday;
  let period = row && row[hour];
  if (!period) throw new Error("tariff: plan " + plan.id + " " + season + "/" + dayType + " hour " + hour + " has no period");
  let overridden = false;
  const ovs = plan.schedule_overrides;
  if (ovs) for (let k = 0; k < ovs.length; k++) {
    const ov = ovs[k];
    if (ov.months && ov.months.indexOf(month) < 0) continue;
    if (ov.daytype && ov.daytype !== dayType) continue;
    if (ov.hours && ov.hours.indexOf(hour) < 0) continue;
    period = ov.period;
    overridden = true;
  }
  return { season, dayType, period, overridden };
}

/**
 * The whole of periodFor() for one plan as a flat 12 x 2 x 24 table of period ids,
 * index (month-1)*48 + weekend*24 + hour.  Everything periodFor depends on is in that
 * key, so a hot loop indexes this instead of calling periodFor per hour.  Not memoised:
 * 576 lookups are nothing next to a year of hours, and a plan edited in place (a
 * custom tariff) must never read a stale table.
 */
export function periodGrid(plan) {
  const g = new Array(576);
  for (let m = 1; m <= 12; m++) for (let w = 0; w < 2; w++) for (let h = 0; h < 24; h++) {
    g[(m - 1) * 48 + w * 24 + h] = periodFor(plan, m, w === 1, h).period;
  }
  return g;
}

const TouPeriods = {
  nthWeekday, lastWeekday, dayOfWeek, holidaysForYear, isHoliday, billsAsWeekend,
  seasonOf, periodFor, periodGrid,
};
export default TouPeriods;
