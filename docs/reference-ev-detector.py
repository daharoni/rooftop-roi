#!/usr/bin/env python3
"""
Parse SCE hourly interval CSV exports -> build/load.json + build/load_summary.json

- Handles UTF-8 BOM, NBSP (U+00A0) padding, 12-hour AM/PM times with and
  without a leading zero ("01:00AM" vs "1:00PM").
- Concatenates multiple exports chronologically, dedupes overlapping timestamps.
- Handles DST days (SCE emits 23 rows on the spring-forward date and 25 rows,
  with one duplicated hour label, on the fall-back date).
- Splits EV charging out of the whole-house load with a percentile-baseline +
  plateau heuristic (see ev_method in the output meta).

Pure stdlib. Usage:  python3 scripts/parse_load.py
"""
import csv
import datetime as dt
import glob
import json
import os
import statistics
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
BUILD_DIR = os.path.join(ROOT, "build")
TZ_NAME = "America/Los_Angeles"
TZ = ZoneInfo(TZ_NAME)

# ---- EV detection tuning -------------------------------------------------
BASELINE_HALF_WINDOW_DAYS = 15   # +/- days used to build the hour-of-day baseline
BASELINE_PCTILE = 0.30           # robust "house only" percentile (pass 1)
NIGHT_HOURS = set(list(range(20, 24)) + list(range(0, 10)))  # 8PM-9:59AM
EV_EXCESS_THRESHOLD = 2.0        # kWh above baseline to call an hour "EV" (night)
EV_CORE_EXCESS = 4.0             # a run must peak above this to be an EV session
DAY_FLATNESS = 1.0               # max (max-min) excess inside a daytime EV plateau
DAY_LEVEL_LO = 0.70              # daytime plateau must sit in [lo,hi] x charger kW
DAY_LEVEL_HI = 1.20


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------
def _clean(s):
    return s.replace(" ", " ").strip()


def parse_file(path):
    """Return (list of (naive local datetime, delivered_kwh, received_kwh), stats)."""
    rows = []
    bad = 0
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith('"'):
                continue  # header / preamble lines
            parts = next(csv.reader([line]))
            if len(parts) < 5:
                continue
            stamp = _clean(parts[1])
            try:
                when = dt.datetime.strptime(stamp, "%m/%d/%Y %I:%M%p")
            except ValueError:
                bad += 1
                continue
            try:
                delivered = float(_clean(parts[3]))
                received = float(_clean(parts[4]))
            except ValueError:
                bad += 1
                continue
            rows.append((when, delivered, received))
    rows.sort(key=lambda r: r[0])
    return rows, bad


def dst_transition_dates(d0, d1):
    """Return (spring_forward_dates, fall_back_dates) between two dates."""
    spring, fall = set(), set()
    day = d0
    while day <= d1:
        a = dt.datetime(day.year, day.month, day.day, 12, tzinfo=TZ).utcoffset()
        nxt = day + dt.timedelta(days=1)
        b = dt.datetime(nxt.year, nxt.month, nxt.day, 12, tzinfo=TZ).utcoffset()
        if b > a:
            spring.add(nxt)
        elif b < a:
            fall.add(nxt)
        day = nxt
    return spring, fall


# --------------------------------------------------------------------------
# EV detection
# --------------------------------------------------------------------------
def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = p * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def build_baseline(by_dh, dates, exclude=None):
    """Baseline house load per (date, hour).

    by_dh: {(date, hour): kwh}. exclude: set of (date, hour) treated as EV and
    left out of the sample (pass 2). Uses the 30th percentile of the remaining
    same-hour samples in a +/-15 day window; falls back to the 30th percentile
    of all samples for that hour when too few clean samples remain.
    """
    exclude = exclude or set()
    date_index = {d: i for i, d in enumerate(dates)}
    base = {}
    for (date, hour), _ in by_dh.items():
        i = date_index[date]
        lo = max(0, i - BASELINE_HALF_WINDOW_DAYS)
        hi = min(len(dates) - 1, i + BASELINE_HALF_WINDOW_DAYS)
        clean_vals, all_vals = [], []
        for j in range(lo, hi + 1):
            key = (dates[j], hour)
            v = by_dh.get(key)
            if v is None:
                continue
            all_vals.append(v)
            if key not in exclude:
                clean_vals.append(v)
        if len(clean_vals) >= 5:
            clean_vals.sort()
            # clean sample already has EV removed -> use the median of it
            b = statistics.median(clean_vals) if exclude else percentile(clean_vals, BASELINE_PCTILE)
        else:
            all_vals.sort()
            b = percentile(all_vals, BASELINE_PCTILE)
        base[(date, hour)] = b
    return base


def detect_ev(series, base, charger_kw):
    """series: ordered [(datetime, kwh)]. Returns {index: ev_kwh}."""
    ev = {}
    n = len(series)
    excess = [max(0.0, series[i][1] - base[(series[i][0].date(), series[i][0].hour)])
              for i in range(n)]

    # --- night window: contiguous runs over threshold whose peak is a real charge
    i = 0
    while i < n:
        when, _ = series[i]
        if when.hour in NIGHT_HOURS and excess[i] > EV_EXCESS_THRESHOLD:
            j = i
            while (j + 1 < n and series[j + 1][0].hour in NIGHT_HOURS
                   and excess[j + 1] > EV_EXCESS_THRESHOLD
                   and (series[j + 1][0] - series[j][0]) <= dt.timedelta(hours=1)):
                j += 1
            if max(excess[i:j + 1]) > EV_CORE_EXCESS:
                for k in range(i, j + 1):
                    ev[k] = min(excess[k], charger_kw)
            i = j + 1
        else:
            i += 1

    # --- daytime window: only flat plateaus that look like the charger
    lo_lvl, hi_lvl = DAY_LEVEL_LO * charger_kw, DAY_LEVEL_HI * charger_kw
    i = 0
    while i < n:
        when, _ = series[i]
        if when.hour not in NIGHT_HOURS and lo_lvl <= excess[i] <= hi_lvl:
            j = i
            while (j + 1 < n and series[j + 1][0].hour not in NIGHT_HOURS
                   and lo_lvl <= excess[j + 1] <= hi_lvl
                   and (series[j + 1][0] - series[j][0]) <= dt.timedelta(hours=1)
                   and max(excess[i:j + 2]) - min(excess[i:j + 2]) < DAY_FLATNESS):
                j += 1
            if j > i:  # need >= 2 consecutive flat hours
                for k in range(i, j + 1):
                    ev[k] = min(excess[k], charger_kw)
            i = j + 1
        else:
            i += 1
    return ev


def infer_charger_kw(series, base):
    """Charger power = median of the top decile of night-time excess."""
    vals = []
    for when, kwh in series:
        if when.hour in NIGHT_HOURS:
            e = kwh - base[(when.date(), when.hour)]
            if e > EV_CORE_EXCESS:
                vals.append(e)
    vals.sort()
    if not vals:
        return 8.0
    top = vals[int(0.90 * len(vals)):]
    return round(statistics.median(top), 2)


def sessions_from(series, ev):
    """Group consecutive EV hours into sessions."""
    out = []
    idxs = sorted(ev)
    i = 0
    while i < len(idxs):
        j = i
        while (j + 1 < len(idxs) and idxs[j + 1] == idxs[j] + 1
               and (series[idxs[j + 1]][0] - series[idxs[j]][0]) <= dt.timedelta(hours=1)):
            j += 1
        start = series[idxs[i]][0]
        total = sum(ev[idxs[k]] for k in range(i, j + 1))
        out.append({"date": start.date().isoformat(),
                    "start_hour": start.hour,
                    "kwh": round(total, 3),
                    "hours": j - i + 1})
        i = j + 1
    # Merge sessions that straddle midnight (e.g. 23:00 -> 00:00 next day)
    merged = []
    for s in out:
        if merged:
            prev = merged[-1]
            p_end = (dt.datetime.fromisoformat(prev["date"]).replace(hour=prev["start_hour"])
                     + dt.timedelta(hours=prev["hours"]))
            cur = dt.datetime.fromisoformat(s["date"]).replace(hour=s["start_hour"])
            if p_end == cur:
                prev["kwh"] = round(prev["kwh"] + s["kwh"], 3)
                prev["hours"] += s["hours"]
                continue
        merged.append(s)
    return merged


# --------------------------------------------------------------------------
def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    paths = sorted(glob.glob(os.path.join(DATA_DIR, "SCE_Usage_*.csv")))
    if not paths:
        raise SystemExit("no SCE_Usage_*.csv files in data/")

    notes = []
    per_file = {}
    for p in paths:
        rows, bad = parse_file(p)
        per_file[p] = rows
        if bad:
            notes.append(f"{os.path.basename(p)}: {bad} unparseable rows skipped")

    # ---- collapse each file to {(date, hour): kwh}, summing the DST duplicate
    d_min = min(r[0].date() for rows in per_file.values() for r in rows)
    d_max = max(r[0].date() for rows in per_file.values() for r in rows)
    spring, fall = dst_transition_dates(d_min - dt.timedelta(days=1), d_max)

    by_dh = {}
    received_total = 0.0
    dup_overlap = 0
    dst_notes = []
    for p in paths:
        seen = {}
        dupes = Counter()
        for when, delivered, received in per_file[p]:
            key = (when.date(), when.hour)
            received_total += received
            if key in seen:
                dupes[key] += 1
                seen[key] += delivered   # DST fall-back duplicate label -> sum
            else:
                seen[key] = delivered
        for key, cnt in dupes.items():
            if key[0] in fall:
                dst_notes.append(
                    f"{key[0].isoformat()} {key[1]:02d}:00 duplicated in "
                    f"{os.path.basename(p)} (DST fall-back 25-hour day); the two "
                    f"readings were summed into one hour slot")
            else:
                dst_notes.append(
                    f"{key[0].isoformat()} {key[1]:02d}:00 duplicated in "
                    f"{os.path.basename(p)} (not a DST date); readings summed")
        for key, val in seen.items():
            if key in by_dh:
                dup_overlap += 1
            by_dh[key] = val  # later file wins on overlap
    if dup_overlap:
        notes.append(f"{dup_overlap} timestamps present in more than one export; "
                     f"the later export's value was kept")

    # ---- build the expected hourly grid, find and fill gaps
    dates = []
    d = d_min
    while d <= d_max:
        dates.append(d)
        d += dt.timedelta(days=1)

    gaps_filled = []
    for d in dates:
        present = sorted(h for h in range(24) if (d, h) in by_dh)
        missing = [h for h in range(24) if (d, h) not in by_dh]
        if d in spring and len(present) == 23 and len(missing) == 1:
            dst_notes.append(
                f"{d.isoformat()} has 23 hours (DST spring-forward); hour "
                f"{missing[0]:02d}:00 does not exist in local clock time and was "
                f"not treated as a gap")
            continue
        if d == d_min:
            missing = [h for h in missing if h > max(present or [-1])]
        if d == d_max:
            missing = [h for h in missing if h < min(present or [24])]
        for h in missing:
            # interpolate the same hour from the nearest adjacent days
            vals = []
            for off in (1, 2, 3):
                for sgn in (-1, 1):
                    k = (d + dt.timedelta(days=sgn * off), h)
                    if k in by_dh:
                        vals.append(by_dh[k])
                if vals:
                    break
            fill = round(statistics.mean(vals), 3) if vals else 0.0
            by_dh[(d, h)] = fill
            gaps_filled.append({"ts": f"{d.isoformat()}T{h:02d}:00",
                                "kwh": fill,
                                "method": "mean of same hour on adjacent days"
                                          if vals else "zero (no neighbours)"})

    # ---- final ordered series
    series = sorted(((dt.datetime(d.year, d.month, d.day, h), v)
                     for (d, h), v in by_dh.items()), key=lambda r: r[0])

    # ---- EV detection (two passes: rough baseline, then EV-free baseline)
    base0 = build_baseline(by_dh, dates)
    charger_kw = infer_charger_kw(series, base0)
    ev0 = detect_ev(series, base0, charger_kw)
    excl = {(series[i][0].date(), series[i][0].hour) for i in ev0}
    base1 = build_baseline(by_dh, dates, exclude=excl)
    charger_kw = infer_charger_kw(series, base1)
    ev1 = detect_ev(series, base1, charger_kw)

    ts, kwh, ev_kwh, base_kwh = [], [], [], []
    for i, (when, v) in enumerate(series):
        e = round(min(ev1.get(i, 0.0), v), 3)
        ts.append(when.strftime("%Y-%m-%dT%H:%M"))
        kwh.append(round(v, 3))
        ev_kwh.append(e)
        base_kwh.append(round(v - e, 3))

    sessions = sessions_from(series, ev1)
    n_hours = len(series)
    span_years = n_hours / 8766.0
    total_kwh = sum(kwh)
    ev_total = sum(ev_kwh)
    day_ev = sum(e for (w, _), e in zip(series, ev_kwh) if w.hour not in NIGHT_HOURS)
    sess_kwh = sorted(s["kwh"] for s in sessions)

    ev_method = (
        f"Two-pass hour-of-day baseline. Pass 1: house baseline for each (date, "
        f"hour) = {int(BASELINE_PCTILE*100)}th percentile of the same hour-of-day "
        f"over a +/-{BASELINE_HALF_WINDOW_DAYS} day window. Pass 2: the baseline is "
        f"recomputed as the median of the same-hour samples with pass-1 EV hours "
        f"removed. Excess = metered kWh - baseline. Overnight window "
        f"(8PM-9:59AM): contiguous runs with excess > {EV_EXCESS_THRESHOLD} kWh are "
        f"attributed to the EV provided the run peaks above {EV_CORE_EXCESS} kWh "
        f"(this keeps the ramp-in/ramp-out hours of a real session while rejecting "
        f"isolated evening house-load bumps). Daytime window (10AM-7:59PM): only "
        f"runs of >=2 consecutive hours whose excess is flat (range < "
        f"{DAY_FLATNESS} kWh) and sits between {DAY_LEVEL_LO:.2f}x and "
        f"{DAY_LEVEL_HI:.2f}x the inferred charger power are attributed to the EV; "
        f"this separates charging plateaus from air-conditioning, which ramps. "
        f"Per-hour EV is capped at the inferred charger power of {charger_kw} kW "
        f"(median of the top decile of overnight excess; consistent with a Tesla "
        f"Wall Connector at 32 A / 240 V = 7.7 kW). Detected daytime charging = "
        f"{day_ev:.0f} kWh ({100*day_ev/ev_total:.1f}% of EV energy)."
    )

    meta = {
        "source_files": [os.path.basename(p) for p in paths],
        "tz": TZ_NAME,
        "start": ts[0],
        "end": ts[-1],
        "n_hours": n_hours,
        "total_kwh": round(total_kwh, 3),
        "ev_kwh_total": round(ev_total, 3),
        "ev_kwh_per_year": round(ev_total / span_years, 1),
        "ev_method": ev_method,
        "gaps_filled": gaps_filled,
        "notes": " | ".join(notes + dst_notes + [
            f"Received (export) energy is {received_total:.3f} kWh over the whole "
            f"record - no existing PV/export.",
            "Timestamps are the local prevailing (clock) time printed by SCE, i.e. "
            "PDT in summer and PST in winter, one entry per metered hour, period "
            "START. Spring-forward days therefore have 23 entries and fall-back "
            "days 25 metered readings folded into 24 slots. Align against the "
            "solar profiles (local STANDARD time) by shifting load back one hour "
            "during DST.",
            f"charger_kw={charger_kw}",
            f"ev_sessions={len(sessions)}, median session {statistics.median(sess_kwh):.2f} kWh, "
            f"{len(sessions)/(span_years*52.18):.2f} sessions/week",
        ]),
        "ev_charger_kw": charger_kw,
        "ev_sessions_count": len(sessions),
        "ev_session_median_kwh": round(statistics.median(sess_kwh), 3),
        "ev_sessions_per_week": round(len(sessions) / (span_years * 52.1775), 2),
    }

    out = {"meta": meta, "ts": ts, "kwh": kwh, "ev_kwh": ev_kwh,
           "base_kwh": base_kwh, "ev_sessions": sessions}
    with open(os.path.join(BUILD_DIR, "load.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    # ---------------- summary ----------------
    monthly = defaultdict(lambda: [0.0, 0.0, 0.0])
    for (when, _), t, e, b in zip(series, kwh, ev_kwh, base_kwh):
        m = when.strftime("%Y-%m")
        monthly[m][0] += t
        monthly[m][1] += b
        monthly[m][2] += e

    def profile(filter_fn):
        s = [[0.0, 0.0, 0.0] for _ in range(24)]
        c = [0] * 24
        for (when, _), t, e, b in zip(series, kwh, ev_kwh, base_kwh):
            if not filter_fn(when):
                continue
            h = when.hour
            s[h][0] += t
            s[h][1] += b
            s[h][2] += e
            c[h] += 1
        return {
            "total": [round(s[h][0] / c[h], 3) if c[h] else 0.0 for h in range(24)],
            "base": [round(s[h][1] / c[h], 3) if c[h] else 0.0 for h in range(24)],
            "ev": [round(s[h][2] / c[h], 3) if c[h] else 0.0 for h in range(24)],
            "n_days": round(sum(c) / 24.0, 1),
        }

    is_summer = lambda w: 6 <= w.month <= 9
    daily = defaultdict(lambda: [0.0, 0.0, 0.0])
    for (when, _), t, e, b in zip(series, kwh, ev_kwh, base_kwh):
        d = when.date().isoformat()
        daily[d][0] += t
        daily[d][1] += b
        daily[d][2] += e
    top20 = sorted(daily.items(), key=lambda kv: -kv[1][0])[:20]

    summary = {
        "meta": {"source": "build/load.json", "n_hours": n_hours,
                 "total_kwh": round(total_kwh, 1),
                 "kwh_per_year": round(total_kwh / span_years, 1),
                 "ev_kwh_per_year": round(ev_total / span_years, 1),
                 "charger_kw": charger_kw,
                 "season_def": "summer = Jun-Sep, winter = Oct-May"},
        "monthly_kwh": {m: {"total": round(v[0], 1), "base": round(v[1], 1),
                            "ev": round(v[2], 1)} for m, v in sorted(monthly.items())},
        "hour_of_day_profile": {
            "summer": profile(is_summer),
            "winter": profile(lambda w: not is_summer(w)),
            "all": profile(lambda w: True),
        },
        "weekday_weekend": {
            "weekday": profile(lambda w: w.weekday() < 5),
            "weekend": profile(lambda w: w.weekday() >= 5),
            "avg_daily_kwh": {
                "weekday": round(sum(v[0] for k, v in daily.items()
                                     if dt.date.fromisoformat(k).weekday() < 5)
                                 / sum(1 for k in daily
                                       if dt.date.fromisoformat(k).weekday() < 5), 2),
                "weekend": round(sum(v[0] for k, v in daily.items()
                                     if dt.date.fromisoformat(k).weekday() >= 5)
                                 / sum(1 for k in daily
                                       if dt.date.fromisoformat(k).weekday() >= 5), 2),
            },
        },
        "top_20_days": [{"date": d, "kwh": round(v[0], 2), "base_kwh": round(v[1], 2),
                         "ev_kwh": round(v[2], 2)} for d, v in top20],
        "ev_stats": {
            "sessions": len(sessions),
            "sessions_per_week": round(len(sessions) / (span_years * 52.1775), 2),
            "median_session_kwh": round(statistics.median(sess_kwh), 2),
            "mean_session_kwh": round(statistics.mean(sess_kwh), 2),
            "p10_session_kwh": round(percentile(sess_kwh, 0.10), 2),
            "p90_session_kwh": round(percentile(sess_kwh, 0.90), 2),
            "charger_kw": charger_kw,
            "ev_kwh_total": round(ev_total, 1),
            "ev_kwh_per_year": round(ev_total / span_years, 1),
            "daytime_ev_kwh": round(day_ev, 1),
            "session_start_hour_histogram": dict(sorted(
                Counter(s["start_hour"] for s in sessions).items())),
        },
    }
    with open(os.path.join(BUILD_DIR, "load_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)

    print(f"hours={n_hours} total={total_kwh:.1f} kWh "
          f"({total_kwh/span_years:.0f}/yr)  EV={ev_total:.1f} "
          f"({ev_total/span_years:.0f}/yr, {100*ev_total/total_kwh:.1f}%)  "
          f"charger={charger_kw} kW  sessions={len(sessions)} "
          f"({len(sessions)/(span_years*52.1775):.2f}/wk, median "
          f"{statistics.median(sess_kwh):.2f} kWh)  gaps_filled={len(gaps_filled)}")


if __name__ == "__main__":
    main()
