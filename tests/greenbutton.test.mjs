/* tests/greenbutton.test.mjs — run with: node --test tests/
 *
 * Only the two SCE files in data/demo are real.  PG&E, SDG&E, ESPI and the
 * generic reader are exercised against synthetic fixtures built here, each a few
 * days long and each containing a DST transition, so the hour-folding rules are
 * tested and not just asserted about.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GB = (await import(path.join(ROOT, "core/greenbutton.js"))).default;

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pad2 = (n) => String(n).padStart(2, "0");
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };

// ---------------------------------------------------------------------------
// 1. SCE — the real demo household must reproduce the prototype's LoadSet
// ---------------------------------------------------------------------------
const FIXTURE = JSON.parse(read("tests/fixtures/load-agoura-hills.json"));

function demoLoadSet() {
  const a = GB.parse(read("data/demo/demo-sce-usage-2024-09.csv"), { filename: "demo-sce-usage-2024-09.csv" });
  const b = GB.parse(read("data/demo/demo-sce-usage-2025-09.csv"), { filename: "demo-sce-usage-2025-09.csv" });
  return { a, b, merged: GB.mergeLoadSets([a, b]) };
}

test("SCE: format is detected from the file's own text", () => {
  assert.equal(GB.detectFormat(read("data/demo/demo-sce-usage-2024-09.csv")), "sce-csv");
  assert.equal(GB.detectFormat(read("data/demo/demo-sce-usage-2025-09.csv")), "sce-csv");
});

test("SCE: each demo file parses to its own hour count", () => {
  const { a, b } = demoLoadSet();
  assert.equal(a.meta.nHours, 8759);      // 365 days, minus the spring-forward hour
  assert.equal(b.meta.nHours, 8975);      // 374 days, minus the spring-forward hour
  assert.equal(a.meta.intervalMinutes, 60);
  assert.equal(a.meta.source, "sce-csv");
  assert.equal(a.meta.utilityHint, "sce");
});

test("SCE: merged demo files reproduce tests/fixtures/load-agoura-hills.json exactly", () => {
  const { merged } = demoLoadSet();
  assert.equal(merged.meta.nHours, 17734);
  assert.equal(merged.meta.nHours, FIXTURE.meta.n_hours);
  assert.equal(merged.meta.start, "2024-09-01T00:00");
  assert.equal(merged.meta.end, "2026-09-09T23:00");
  assert.ok(Math.abs(merged.meta.totalKwh - 26878.49) < 0.01,
    `total ${merged.meta.totalKwh} != 26878.49`);

  let tsBad = 0, kwhBad = 0, worst = 0;
  for (let i = 0; i < FIXTURE.ts.length; i++) {
    if (merged.ts[i] !== FIXTURE.ts[i]) tsBad++;
    const d = Math.abs(merged.kwh[i] - FIXTURE.kwh[i]);
    if (d > 1e-9) { kwhBad++; worst = Math.max(worst, d); }
  }
  assert.equal(tsBad, 0, "timestamps differ from the fixture");
  assert.equal(kwhBad, 0, `${kwhBad} kWh values differ (worst ${worst})`);
});

test("SCE: DST days fold the way the prototype folded them", () => {
  const { merged } = demoLoadSet();
  const byDate = new Map();
  for (const t of merged.ts) byDate.set(t.slice(0, 10), (byDate.get(t.slice(0, 10)) || 0) + 1);
  const odd = [...byDate].filter(([, n]) => n !== 24);
  assert.deepEqual(odd, [["2025-03-09", 23], ["2026-03-08", 23]]);

  const notes = merged.meta.notes.join(" | ");
  assert.match(notes, /2024-11-03 04:00 duplicated \(DST fall-back/);
  assert.match(notes, /2025-11-02 10:00 duplicated \(DST fall-back/);
  assert.match(notes, /2025-03-09 has 23 hours \(DST spring-forward\)/);
  assert.match(notes, /2026-03-08 has 23 hours \(DST spring-forward\)/);

  // the duplicated fall-back hour is the SUM of the two readings
  const i = merged.ts.indexOf("2024-11-03T04:00");
  assert.ok(Math.abs(merged.kwh[i] - (0.468 + 0.510)) < 1e-9);
});

test("SCE: the demo household never exports, so exportKwh is null", () => {
  const { merged } = demoLoadSet();
  assert.equal(merged.exportKwh, null);
  assert.match(merged.meta.notes.join(" | "), /Received \(export\) energy is 0 kWh/);
});

test("SCE: only the ZIP survives the header block", () => {
  const { merged, a } = demoLoadSet();
  assert.equal(a.meta.zip, "91301");
  assert.equal(merged.meta.zip, "91301");
  const blob = JSON.stringify(merged.meta).toUpperCase();
  for (const secret of ["DEMO HOUSEHOLD", "AGOURA HILLS", "8009999999", "SERVICE ACCOUNT"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

test("SCE: quality block reports hours / days / years / missing / filled", () => {
  const { merged } = demoLoadSet();
  assert.deepEqual(merged.meta.quality, {
    hours: 17734, days: 739, years: 17734 / 8766, missing: 0, filled: 0, partialHours: 0,
  });
  assert.deepEqual(merged.meta.gapsFilled, []);
});

// ---------------------------------------------------------------------------
// 2. PG&E — synthetic, 15-minute, both DST transitions
// ---------------------------------------------------------------------------
/** Clock hours a US local day actually has: 25 on fall-back, 23 on spring-forward. */
function clockHours(date) {
  if (date === "2025-11-02") return [0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  if (date === "2025-03-09") return [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  return Array.from({ length: 24 }, (_, h) => h);
}

const PGE_HEADER = [
  "Name,JANE Q CUSTOMER",
  'Address,"1 Example Way, OAKLAND, CA 94610"',
  "Account Number,1234567890-9",
  "Service,Electric service",
  "",
  "Electric usage",
  "TYPE,DATE,START TIME,END TIME,USAGE (kWh),COST,NOTES",
].join("\n");

/** 15-minute PG&E file: 0.1 kWh in every quarter hour => 0.4 kWh in every clock hour. */
function pgeCsv(dates) {
  const rows = [PGE_HEADER];
  for (const d of dates) {
    for (const h of clockHours(d)) {
      for (let q = 0; q < 4; q++) {
        const m0 = q * 15, m1 = m0 + 14;          // PG&E prints the inclusive last minute
        rows.push(`Electric usage,${d},${pad2(h)}:${pad2(m0)},${pad2(h)}:${pad2(m1)},0.1,$0.04,`);
      }
    }
    rows.push(`Natural gas usage,${d},00:00,00:59,3.2,$1.10,`);   // must be ignored
  }
  return rows.join("\n") + "\n";
}

test("PG&E: 15-minute data is summed to hours, gas rows and identity are dropped", () => {
  const text = pgeCsv(["2025-11-01", "2025-11-02", "2025-11-03"]);
  assert.equal(GB.detectFormat(text), "pge-csv");
  const ls = GB.parse(text);

  assert.equal(ls.meta.source, "pge-csv");
  assert.equal(ls.meta.intervalMinutes, 15);
  assert.equal(ls.meta.utilityHint, "pge");
  assert.equal(ls.meta.zip, "94610");
  assert.equal(ls.meta.nHours, 72);                    // 25-hour day folds into 24 slots
  assert.ok(Math.abs(ls.meta.totalKwh - 73 * 0.4) < 1e-6);

  const i = ls.ts.indexOf("2025-11-02T01:00");
  assert.ok(Math.abs(ls.kwh[i] - 0.8) < 1e-9, "the repeated fall-back hour is summed");
  assert.match(ls.meta.notes.join(" | "), /2025-11-02 01:00 duplicated \(DST fall-back/);
  assert.match(ls.meta.notes.join(" | "), /3 non-electric rows skipped/);

  const blob = JSON.stringify(ls.meta).toUpperCase();
  for (const secret of ["JANE", "EXAMPLE WAY", "OAKLAND", "1234567890"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

test("PG&E: the spring-forward day has 23 hours and is not reported as a gap", () => {
  const ls = GB.parse(pgeCsv(["2025-03-08", "2025-03-09", "2025-03-10"]));
  assert.equal(ls.meta.nHours, 71);
  assert.equal(ls.meta.quality.missing, 0);
  assert.equal(ls.meta.gapsFilled.length, 0);
  assert.equal(ls.ts.indexOf("2025-03-09T01:00"), -1);
  assert.match(ls.meta.notes.join(" | "), /2025-03-09 has 23 hours \(DST spring-forward\)/);
});

test("PG&E: a negative USAGE row is read as export", () => {
  const text = [PGE_HEADER,
    "Electric usage,2025-06-01,00:00,00:59,1.0,$0.30,",
    "Electric usage,2025-06-01,01:00,01:59,-0.5,$0.00,",
    "Electric usage,2025-06-01,02:00,02:59,1.0,$0.30,",
  ].join("\n");
  const ls = GB.parse(text);
  assert.ok(ls.exportKwh, "exportKwh should not be null");
  assert.equal(ls.exportKwh[1], 0.5);
  assert.equal(ls.kwh[1], 0);
});

// ---------------------------------------------------------------------------
// 3. SDG&E — synthetic, hourly, with a generation channel
// ---------------------------------------------------------------------------
function sdgeCsv(dates, { generation = 0 } = {}) {
  const rows = [
    "Electric Usage Data",
    "Account Number,987654321",
    "Service Address,42 Coast Hwy, SAN DIEGO, CA 92101",
    "Meter Number,SDG0099887",
    "",
    "Meter Number,Date,Start Time,Duration,Consumption,Generation,Net",
  ];
  for (const d of dates) {
    for (const h of clockHours(d)) {
      const g = h >= 9 && h < 16 ? generation : 0;
      rows.push(`SDG0099887,${d},${pad2(h)}:00,01:00:00,1.250,${g.toFixed(3)},${(1.25 - g).toFixed(3)}`);
    }
  }
  return rows.join("\n") + "\n";
}

test("SDG&E: hourly data, fall-back folding, generation kept as export, meter number dropped", () => {
  const text = sdgeCsv(["2025-11-01", "2025-11-02", "2025-11-03"], { generation: 2 });
  assert.equal(GB.detectFormat(text), "sdge-csv");
  const ls = GB.parse(text);

  assert.equal(ls.meta.source, "sdge-csv");
  assert.equal(ls.meta.utilityHint, "sdge");
  assert.equal(ls.meta.zip, "92101");
  assert.equal(ls.meta.intervalMinutes, 60);
  assert.equal(ls.meta.nHours, 72);
  assert.ok(Math.abs(ls.meta.totalKwh - 73 * 1.25) < 1e-6);
  assert.ok(Math.abs(ls.kwh[ls.ts.indexOf("2025-11-02T01:00")] - 2.5) < 1e-9);

  assert.ok(ls.exportKwh);
  assert.ok(Math.abs(sum(ls.exportKwh) - 3 * 7 * 2) < 1e-6);

  const blob = JSON.stringify(ls.meta).toUpperCase();
  for (const secret of ["SDG0099887", "987654321", "COAST HWY", "SAN DIEGO"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

test("SDG&E: 15-minute durations are summed to hours", () => {
  const rows = ["Meter Number,Date,Start Time,Duration,Consumption,Generation,Net"];
  for (let h = 0; h < 24; h++) {
    for (let q = 0; q < 4; q++) rows.push(`M1,2025-06-01,${pad2(h)}:${pad2(q * 15)},00:15:00,0.250,0.000,0.250`);
  }
  const ls = GB.parseSdgeCsv(rows.join("\n"));
  assert.equal(ls.meta.intervalMinutes, 15);
  assert.equal(ls.meta.nHours, 24);
  assert.ok(Math.abs(ls.kwh[0] - 1.0) < 1e-9);
});

// ---------------------------------------------------------------------------
// 4. ESPI XML — synthetic Atom feed across the fall-back transition
// ---------------------------------------------------------------------------
/** epoch seconds of 2025-11-01T00:00 local (PDT, UTC-7). */
const ESPI_START = Date.UTC(2025, 10, 1, 7, 0, 0) / 1000;

function espiXml({ hours = 73, withExport = false } = {}) {
  const block = (flow, offsetWh) => {
    const readings = [];
    for (let i = 0; i < hours; i++) {
      readings.push(
        `<IntervalReading><timePeriod><duration>3600</duration>` +
        `<start>${ESPI_START + i * 3600}</start></timePeriod>` +
        `<value>${offsetWh}</value></IntervalReading>`);
    }
    return (
      `<entry><title>Reading type</title><content><ReadingType>` +
      `<flowDirection>${flow}</flowDirection><powerOfTenMultiplier>0</powerOfTenMultiplier>` +
      `<uom>72</uom></ReadingType></content></entry>` +
      `<entry><title>Interval block</title><content><IntervalBlock>` +
      readings.join("") + `</IntervalBlock></content></entry>`);
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
<title>Green Button Usage Feed for JOHN DOE, account 55512345678</title>
<entry><title>Local time parameters</title><content><LocalTimeParameters>
  <dstEndRule>B40E2000</dstEndRule><dstOffset>3600</dstOffset>
  <dstStartRule>360E2000</dstStartRule><tzOffset>-28800</tzOffset>
</LocalTimeParameters></content></entry>
<entry><title>Usage point</title><content><UsagePoint><ServiceLocation>
  <mainAddress><streetDetail><number>9</number><name>Hidden Lane</name></streetDetail>
  <townDetail><name>PASADENA</name><stateOrProvince>CA</stateOrProvince>
  <postalCode>91101</postalCode></townDetail></mainAddress>
</ServiceLocation></UsagePoint></content></entry>
${block(1, 1000)}${withExport ? block(19, 500) : ""}
</feed>`;
}

test("ESPI: epoch seconds become local clock time and the fall-back hour folds", () => {
  const text = espiXml();
  assert.equal(GB.detectFormat(text), "espi-xml");
  const ls = GB.parse(text);

  assert.equal(ls.meta.source, "espi-xml");
  assert.equal(ls.meta.tz, "America/Los_Angeles");
  assert.equal(ls.meta.intervalMinutes, 60);
  assert.equal(ls.meta.start, "2025-11-01T00:00");
  assert.equal(ls.meta.nHours, 72, "73 readings fold into 72 clock hours");
  assert.ok(Math.abs(ls.meta.totalKwh - 73) < 1e-6, "1000 Wh per reading = 1 kWh");
  assert.ok(Math.abs(ls.kwh[ls.ts.indexOf("2025-11-02T01:00")] - 2) < 1e-9);
  assert.match(ls.meta.notes.join(" | "), /2025-11-02 01:00 duplicated \(DST fall-back/);
  assert.equal(ls.meta.quality.missing, 0);
});

test("ESPI: flowDirection 19 becomes export, and the feed's identity is not kept", () => {
  const ls = GB.parse(espiXml({ withExport: true }));
  assert.ok(ls.exportKwh);
  assert.ok(Math.abs(sum(ls.kwh) - 73) < 1e-6);
  assert.ok(Math.abs(sum(ls.exportKwh) - 73 * 0.5) < 1e-6);
  assert.equal(ls.meta.zip, "91101");
  const blob = JSON.stringify(ls.meta).toUpperCase();
  for (const secret of ["JOHN DOE", "55512345678", "HIDDEN LANE", "PASADENA"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

test("ESPI: powerOfTenMultiplier scales the value", () => {
  const text = espiXml().replace("<powerOfTenMultiplier>0<", "<powerOfTenMultiplier>3<");
  const ls = GB.parseEspiXml(text);
  assert.ok(Math.abs(ls.meta.totalKwh - 73000) < 1e-3);
});

test("ESPI: the regex fallback walker agrees with the DOM-free path", () => {
  const tree = GB.xmlWalkFallback(espiXml());
  assert.equal(tree.children[0].lname, "feed");
  const names = new Set();
  (function walk(n) { for (const c of n.children) { names.add(c.lname); walk(c); } })(tree);
  assert.ok(names.has("intervalreading"));
  assert.ok(names.has("localtimeparameters"));
});

// ---------------------------------------------------------------------------
// 5. Generic CSV
// ---------------------------------------------------------------------------
function genericCsv({ delim = ",", skip = [], header = "Timestamp,kWh" } = {}) {
  const rows = [header];
  for (let h = 0; h < 48; h++) {
    const d = h < 24 ? "2025-06-01" : "2025-06-02";
    const hh = pad2(h % 24);
    if (skip.includes(h)) continue;
    rows.push([`${d}T${hh}:00`, (1 + (h % 24) / 100).toFixed(3)].join(delim));
  }
  return rows.join("\n") + "\n";
}

test("generic CSV: a timestamp column and a kWh column are enough", () => {
  const text = genericCsv();
  assert.equal(GB.detectFormat(text), "generic-csv");
  const ls = GB.parse(text);
  assert.equal(ls.meta.source, "generic-csv");
  assert.equal(ls.meta.nHours, 48);
  assert.ok(Math.abs(ls.kwh[0] - 1.0) < 1e-9);
  assert.match(ls.meta.notes.join(" | "), /Generic CSV: delimiter ","/);
});

test("generic CSV: the delimiter is sniffed", () => {
  for (const d of [";", "\t", "|"]) {
    const ls = GB.parseGenericCsv(genericCsv({ delim: d, header: ["Timestamp", "kWh"].join(d) }));
    assert.equal(ls.meta.nHours, 48, `delimiter ${JSON.stringify(d)}`);
  }
});

test("generic CSV: separate Date and Start Time columns also work", () => {
  const rows = ["Date,Start Time,Usage (kWh),Received"];
  for (let h = 0; h < 24; h++) rows.push(`06/01/2025,${pad2(h)}:00,2.000,0.500`);
  const ls = GB.parseGenericCsv(rows.join("\n"));
  assert.equal(ls.meta.nHours, 24);
  assert.ok(Math.abs(ls.meta.totalKwh - 48) < 1e-9);
  assert.ok(ls.exportKwh && Math.abs(sum(ls.exportKwh) - 12) < 1e-9);
});

test("generic CSV: a preamble of identifying fields is dropped except the ZIP", () => {
  const rows = [
    "Customer Name,JANE Q CUSTOMER",
    'Service Address,"1 Example Way, PASADENA, CA 91101"',
    "Service Account,8009999999",
    "Meter Number,55512345678",
    "",
    "Timestamp,kWh",
  ];
  for (let h = 0; h < 24; h++) rows.push(`2025-06-01T${pad2(h)}:00,1.000`);
  const ls = GB.parse(rows.join("\n"));

  assert.equal(ls.meta.source, "generic-csv");
  assert.equal(ls.meta.nHours, 24);
  assert.equal(ls.meta.zip, "91101", "the ZIP is the one header field worth keeping");
  const blob = JSON.stringify(ls.meta).toUpperCase();
  for (const secret of ["JANE Q CUSTOMER", "EXAMPLE WAY", "PASADENA", "8009999999", "55512345678"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Gaps
// ---------------------------------------------------------------------------
test("gaps: a run of <= 3 hours is interpolated from adjacent days and listed", () => {
  const ls = GB.parseGenericCsv(genericCsv({ skip: [10, 11] }));
  assert.equal(ls.meta.nHours, 48);
  assert.equal(ls.meta.gapsFilled.length, 2);
  assert.equal(ls.meta.quality.filled, 2);
  assert.equal(ls.meta.quality.missing, 0);
  assert.equal(ls.meta.gapsFilled[0].ts, "2025-06-01T10:00");
  // hour 10 the next day is 1.10; the only neighbour one day away
  assert.ok(Math.abs(ls.kwh[10] - 1.1) < 1e-9);
  assert.match(ls.meta.gapsFilled[0].method, /same hour on adjacent days/);
});

test("gaps: a run longer than 3 hours stays NaN and is counted", () => {
  const ls = GB.parseGenericCsv(genericCsv({ skip: [8, 9, 10, 11, 12, 13] }));
  assert.equal(ls.meta.nHours, 48);
  assert.equal(ls.meta.quality.filled, 0);
  assert.equal(ls.meta.quality.missing, 6);
  for (let i = 8; i <= 13; i++) assert.ok(Number.isNaN(ls.kwh[i]), `hour ${i} should be NaN`);
  assert.ok(!Number.isNaN(ls.meta.totalKwh));
  assert.match(ls.meta.notes.join(" | "), /6 consecutive hours missing/);
});

// ---------------------------------------------------------------------------
// 7. mergeLoadSets
// ---------------------------------------------------------------------------
test("merge: sets are ordered chronologically whatever order they arrive in", () => {
  const { a, b, merged } = demoLoadSet();
  const flipped = GB.mergeLoadSets([b, a]);
  assert.equal(flipped.meta.start, merged.meta.start);
  assert.equal(flipped.meta.end, merged.meta.end);
  assert.equal(flipped.meta.nHours, merged.meta.nHours);
  assert.equal(GB.mergeLoadSets([a]).meta.nHours, a.meta.nHours);
});

test("merge: overlapping hours are deduped, the later export winning", () => {
  const one = GB.parseGenericCsv(genericCsv());                     // Jun 1-2
  const rows = ["Timestamp,kWh"];
  for (let h = 0; h < 24; h++) rows.push(`2025-06-02T${pad2(h)}:00,9.000`);
  for (let h = 0; h < 24; h++) rows.push(`2025-06-03T${pad2(h)}:00,5.000`);
  const two = GB.parseGenericCsv(rows.join("\n"));

  const m = GB.mergeLoadSets([one, two]);
  assert.equal(m.meta.nHours, 72);
  assert.equal(m.kwh[m.ts.indexOf("2025-06-02T00:00")], 9);          // later file wins
  assert.equal(m.kwh[m.ts.indexOf("2025-06-01T00:00")], 1);
  assert.match(m.meta.notes.join(" | "), /24 clock hours were present in more than one export/);
});

test("merge: a hole between two exports is reported like any other gap", () => {
  const one = GB.parseGenericCsv(genericCsv());                     // Jun 1-2
  const rows = ["Timestamp,kWh"];
  for (let h = 0; h < 24; h++) rows.push(`2025-06-04T${pad2(h)}:00,3.000`);
  const two = GB.parseGenericCsv(rows.join("\n"));
  const m = GB.mergeLoadSets([one, two]);
  assert.equal(m.meta.nHours, 96);
  assert.equal(m.meta.quality.missing, 24, "a whole missing day is left as NaN");
  assert.match(m.meta.notes.join(" | "), /24 consecutive hours missing/);
});

// ---------------------------------------------------------------------------
// 8. odds and ends
// ---------------------------------------------------------------------------
test("a UTF-8 BOM and NBSP padding do not break the SCE reader", () => {
  const text = "﻿" + read("data/demo/demo-sce-usage-2024-09.csv");
  assert.equal(GB.detectFormat(text), "sce-csv");
  assert.equal(GB.parse(text).meta.nHours, 8759);
});

test("findZip accepts a state+ZIP or a labelled field, and ignores account numbers", () => {
  assert.equal(GB.findZip("For location: SOMEONE, AGOURA HILLS CA 91301"), "91301");
  assert.equal(GB.findZip("ZIP Code: 90210"), "90210");
  assert.equal(GB.findZip("Account Number,8009999999"), null);
});

test("an unparseable file throws rather than returning an empty LoadSet", () => {
  assert.throws(() => GB.parse(""), /empty file/);
  assert.throws(() => GB.parse("not,a,usage,file\n1,2,3,4\n"), /generic CSV/);
});

test("12-hour times with and without a leading zero both parse", () => {
  assert.deepEqual(GB.parseTimeParts("12:00AM"), { h: 0, mi: 0 });
  assert.deepEqual(GB.parseTimeParts("1:00PM "), { h: 13, mi: 0 });
  assert.deepEqual(GB.parseTimeParts("01:00PM"), { h: 13, mi: 0 });
  assert.deepEqual(GB.parseTimeParts("12:00PM"), { h: 12, mi: 0 });
  assert.deepEqual(GB.parseTimeParts("23:45"), { h: 23, mi: 45 });
});

// ---------------------------------------------------------------------------
// 9. Public-launch review fixes (docs/REVIEW-2026-10-02.md P0 #7, #8 and the
//    parser P1 list)
// ---------------------------------------------------------------------------
test("daily-interval files are refused with a userMessage, not turned into 96% NaN", () => {
  const rows = ["Timestamp,kWh"];
  for (let d = 1; d <= 30; d++) rows.push(`2025-06-${pad2(d)}T00:00,24.000`);
  assert.throws(() => GB.parse(rows.join("\n")), (err) => {
    assert.equal(err.name, "LoadFileError");
    assert.ok(err instanceof GB.LoadFileError);
    assert.equal(err.code, "coarse-interval");
    assert.match(err.userMessage, /daily readings/);
    assert.match(err.userMessage, /hourly or 15-minute/);
    return true;
  });
});

test("a daily PG&E export is refused with PG&E's own re-download hint", () => {
  const rows = ["Name,JANE DOE", "", "TYPE,DATE,START TIME,END TIME,USAGE (kWh),COST,NOTES"];
  for (let d = 1; d <= 20; d++) rows.push(`Electric usage,2025-06-${pad2(d)},00:00,23:59,24.10,$7.00,`);
  assert.throws(() => GB.parse(rows.join("\n")), (err) => {
    assert.ok(err instanceof GB.LoadFileError, `got ${err.name}: ${err.message}`);
    assert.match(err.userMessage, /pge\.com/);
    assert.match(err.userMessage, /range of days/);
    return true;
  });
});

test("ESPI: a daily-duration feed is refused", () => {
  const xml = espiXml({ hours: 10 }).replace(/<duration>3600</g, "<duration>86400<")
    .replace(/<start>(\d+)</g, (m, v) => `<start>${ESPI_START + (+v - ESPI_START) * 24}<`);
  assert.throws(() => GB.parse(xml), (err) => err instanceof GB.LoadFileError && /daily/.test(err.userMessage));
});

/** A linked ESPI feed: one electric UsagePoint and one gas UsagePoint. */
function espiLinked({ gasFirst = true, electricFlow = 1, electricValues = null } = {}) {
  const B = "https://utility.example/DataCustodian/espi/1_1/resource/Subscription/9";
  const readings = (vals) => vals.map((v, i) =>
    `<IntervalReading><timePeriod><duration>3600</duration><start>${ESPI_START + i * 3600}</start>` +
    `</timePeriod><value>${v}</value></IntervalReading>`).join("");
  const ev = electricValues || Array.from({ length: 24 }, () => 1000);
  const gasVals = Array.from({ length: 24 }, () => 3);       // 3 therms an hour
  const entry = (self, up, related, body) =>
    `<entry><link rel="self" href="${self}"/>` + (up ? `<link rel="up" href="${up}"/>` : "") +
    related.map((r) => `<link rel="related" href="${r}"/>`).join("") +
    `<content>${body}</content></entry>`;
  const up1 = `${B}/UsagePoint/1`, up2 = `${B}/UsagePoint/2`;
  const rtE = entry(`${B.replace(/Subscription\/9$/, "")}ReadingType/7`, null, [],
    `<ReadingType><flowDirection>${electricFlow}</flowDirection><powerOfTenMultiplier>0</powerOfTenMultiplier><uom>72</uom></ReadingType>`);
  const rtG = entry(`${B.replace(/Subscription\/9$/, "")}ReadingType/8`, null, [],
    `<ReadingType><flowDirection>1</flowDirection><powerOfTenMultiplier>0</powerOfTenMultiplier><uom>169</uom></ReadingType>`);
  const parts = [
    entry(up1, `${B}/UsagePoint`, [`${up1}/MeterReading`],
      `<UsagePoint><ServiceCategory><kind>0</kind></ServiceCategory></UsagePoint>`),
    entry(up2, `${B}/UsagePoint`, [`${up2}/MeterReading`],
      `<UsagePoint><ServiceCategory><kind>1</kind></ServiceCategory></UsagePoint>`),
    entry(`${up1}/MeterReading/1`, `${up1}/MeterReading`,
      [`${B.replace(/Subscription\/9$/, "")}ReadingType/7`, `${up1}/MeterReading/1/IntervalBlock`], `<MeterReading/>`),
    entry(`${up2}/MeterReading/1`, `${up2}/MeterReading`,
      [`${B.replace(/Subscription\/9$/, "")}ReadingType/8`, `${up2}/MeterReading/1/IntervalBlock`], `<MeterReading/>`),
  ];
  // Document order deliberately puts the GAS ReadingType right before the ELECTRIC
  // block, so "the ReadingType that precedes it" would be wrong.
  const ibE = entry(`${up1}/MeterReading/1/IntervalBlock/1`, `${up1}/MeterReading/1/IntervalBlock`, [],
    `<IntervalBlock>${readings(ev)}</IntervalBlock>`);
  const ibG = entry(`${up2}/MeterReading/1/IntervalBlock/1`, `${up2}/MeterReading/1/IntervalBlock`, [],
    `<IntervalBlock>${readings(gasVals)}</IntervalBlock>`);
  parts.push(...(gasFirst ? [rtE, rtG, ibE, ibG] : [rtG, ibG, rtE, ibE]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><content><LocalTimeParameters><dstOffset>3600</dstOffset><tzOffset>-28800</tzOffset></LocalTimeParameters></content></entry>
${parts.join("\n")}
</feed>`;
}

test("ESPI: a gas UsagePoint's therms are excluded, matched through the MeterReading links", () => {
  for (const gasFirst of [true, false]) {
    const ls = GB.parse(espiLinked({ gasFirst }));
    assert.equal(ls.meta.nHours, 24);
    assert.ok(Math.abs(ls.meta.totalKwh - 24) < 1e-9, `total ${ls.meta.totalKwh} should be 24 kWh of electricity only`);
    const notes = ls.meta.notes.join(" | ");
    assert.match(notes, /skipped gas UsagePoint, uom 169 \(therm\)/);
    assert.match(notes, /matched to its ReadingType through the MeterReading links/);
  }
});

test("ESPI: a feed with only gas is refused with a userMessage", () => {
  const xml = espiLinked().replace(/<kind>0<\/kind>/, "<kind>1</kind>");
  assert.throws(() => GB.parse(xml), (err) => err instanceof GB.LoadFileError && /electric/.test(err.userMessage));
});

test("ESPI: flowDirection 4 (net) splits sign; nothing negative reaches kwh", () => {
  const vals = Array.from({ length: 24 }, (_, h) => (h >= 10 && h < 16 ? -2000 : 1500));
  const ls = GB.parse(espiLinked({ electricFlow: 4, electricValues: vals }));
  for (const v of ls.kwh) assert.ok(v >= 0, `negative kwh ${v}`);
  assert.ok(ls.exportKwh, "export channel present");
  assert.ok(Math.abs(sum(ls.kwh) - 18 * 1.5) < 1e-9);
  assert.ok(Math.abs(sum(ls.exportKwh) - 6 * 2) < 1e-9);
  assert.equal(ls.kwh[ls.ts.indexOf("2025-11-01T12:00")], 0);
  assert.equal(ls.exportKwh[ls.ts.indexOf("2025-11-01T12:00")], 2);
  assert.match(ls.meta.notes.join(" | "), /flowDirection 4 \(net\)/);
});

test("ESPI: a negative forward reading becomes export, never negative load", () => {
  const xml = espiXml({ hours: 24 }).replace(/<value>1000</, "<value>-400<");
  const ls = GB.parse(xml);
  for (const v of ls.kwh) assert.ok(v >= 0);
  assert.ok(Math.abs(sum(ls.exportKwh) - 0.4) < 1e-9);
});

/** 15-minute generic CSV over two days; `drop` lists [hour, quarter] readings to omit. */
function quarterCsv(drop = []) {
  const skip = new Set(drop.map(([h, q]) => h * 4 + q));
  const rows = ["Timestamp,kWh"];
  for (let h = 0; h < 48; h++) {
    for (let q = 0; q < 4; q++) {
      if (skip.has(h * 4 + q)) continue;
      const d = h < 24 ? "2025-06-01" : "2025-06-02";
      rows.push(`${d}T${pad2(h % 24)}:${pad2(q * 15)},0.250`);
    }
  }
  return rows.join("\n");
}

test("partial 15-minute hours: >= half present is scaled up, < half is a gap; both counted", () => {
  const ls = GB.parse(quarterCsv([[5, 1], [7, 0], [7, 1], [7, 2], [30, 0], [30, 3]]));
  assert.equal(ls.meta.intervalMinutes, 15);
  assert.equal(ls.meta.nHours, 48);
  assert.equal(ls.meta.quality.partialHours, 3);
  assert.ok(Math.abs(ls.kwh[5] - 1) < 1e-9, `3 of 4 quarters scaled to ${ls.kwh[5]}`);
  assert.ok(Math.abs(ls.kwh[30] - 1) < 1e-9, `2 of 4 quarters scaled to ${ls.kwh[30]}`);
  assert.ok(Math.abs(ls.kwh[7] - 1) < 1e-9, "1 of 4 is dropped and refilled from the next day");
  assert.equal(ls.meta.quality.filled, 1);
  assert.ok(Math.abs(ls.meta.totalKwh - 48) < 1e-9, "no energy is lost to the missing quarters");
  const notes = ls.meta.notes.join(" | ");
  assert.match(notes, /2 hours had only some of their 15-minute readings/);
  assert.match(notes, /1 hour had less than half/);
});

test("merge: a NaN in a later export never overwrites a real value; missing is recounted", () => {
  const one = GB.parseGenericCsv(genericCsv());                     // Jun 1-2, finite
  const rows = ["Timestamp,kWh"];
  for (let h = 6; h < 24; h++) rows.push(`2025-06-02T${pad2(h)}:00,1.000`);   // Jun 2 00-05 absent
  for (let h = 0; h < 24; h++) rows.push(`2025-06-03T${pad2(h)}:00,1.000`);
  const two = GB.parseGenericCsv(rows.join("\n"));
  // make the later export carry an explicit NaN block over Jun 2 00:00-05:00
  const nanTwo = {
    ...two,
    ts: Array.from({ length: 6 }, (_, h) => `2025-06-02T${pad2(h)}:00`).concat(two.ts),
    kwh: Float64Array.from([NaN, NaN, NaN, NaN, NaN, NaN, ...two.kwh]),
    meta: { ...two.meta, quality: { ...two.meta.quality, missing: 6 } },
  };
  const m = GB.mergeLoadSets([one, nanTwo]);
  for (let h = 0; h < 6; h++) {
    const v = m.kwh[m.ts.indexOf(`2025-06-02T${pad2(h)}:00`)];
    assert.ok(Math.abs(v - (1 + h / 100)) < 1e-9, `Jun 2 ${h}:00 = ${v}`);
  }
  assert.equal(m.meta.quality.missing, 0);

  // and a NaN that nobody else covers is still counted
  let nan = 0;
  const m2 = GB.mergeLoadSets([GB.parseGenericCsv(genericCsv()), {
    ...two, ts: two.ts.concat(Array.from({ length: 6 }, (_, h) => `2025-06-04T${pad2(h)}:00`),
                              ["2025-06-04T06:00"]),
    kwh: Float64Array.from([...two.kwh, NaN, NaN, NaN, NaN, NaN, NaN, 2]),
  }]);
  for (const v of m2.kwh) if (Number.isNaN(v)) nan++;
  assert.equal(m2.meta.quality.missing, nan);
  assert.ok(nan >= 6, `${nan} NaN hours`);
});

test("merge: overlapping exports that disagree are flagged as possibly different meters", () => {
  const one = GB.parseGenericCsv(genericCsv());
  const rows = ["Timestamp,kWh"];
  for (let h = 0; h < 48; h++) {
    rows.push(`${h < 24 ? "2025-06-01" : "2025-06-02"}T${pad2(h % 24)}:00,${(2 * (1 + (h % 24) / 100)).toFixed(3)}`);
  }
  const m = GB.mergeLoadSets([one, GB.parseGenericCsv(rows.join("\n"))]);
  assert.match(m.meta.notes.join(" | "), /may be from different meters/);
  const same = GB.mergeLoadSets([one, GB.parseGenericCsv(genericCsv())]);
  assert.doesNotMatch(same.meta.notes.join(" | "), /different meters/);
});

test("generic CSV: Z and +/-hh:mm timestamps are converted to Los Angeles clock time", () => {
  const z = ["Timestamp,kWh"];
  for (let h = 0; h < 48; h++) {
    const t = new Date(Date.UTC(2025, 6, 1, 7 + h)).toISOString();         // ...T07:00:00.000Z
    z.push(`${t},${(1 + h / 100).toFixed(3)}`);
  }
  const ls = GB.parseGenericCsv(z.join("\n"));
  assert.equal(ls.meta.start, "2025-07-01T00:00", "07:00Z is midnight PDT");
  assert.equal(ls.kwh[0], 1);
  assert.match(ls.meta.notes.join(" | "), /48 of 48 timestamps carried a UTC offset \(the first was Z\) and were converted to America\/Los_Angeles/);

  const off = ["Timestamp,kWh", "2025-07-01T03:00:00-04:00,1.5", "2025-07-01T04:00:00-04:00,2.5",
               "2025-07-01T05:00:00-04:00,3.5"];
  const lo = GB.parseGenericCsv(off.join("\n"));
  assert.equal(lo.meta.start, "2025-07-01T00:00", "03:00 EDT is 00:00 PDT");

  // fall-back: 08:00Z and 09:00Z on 2025-11-02 are both 01:00 local and fold together
  const fb = ["Timestamp,kWh"];
  for (let h = 0; h < 6; h++) fb.push(`${new Date(Date.UTC(2025, 10, 2, 6 + h)).toISOString()},1.000`);
  const f = GB.parseGenericCsv(fb.join("\n"));
  assert.ok(Math.abs(f.kwh[f.ts.indexOf("2025-11-02T01:00")] - 2) < 1e-9);
});

test("parseStamp keeps the printed clock and reports the offset; fractional seconds parse", () => {
  assert.deepEqual(GB.parseStamp("2025-07-01T07:15:30.250Z"), { y: 2025, mo: 7, d: 1, h: 7, mi: 15, off: 0 });
  assert.deepEqual(GB.parseStamp("2025-07-01 07:15:00-0700"), { y: 2025, mo: 7, d: 1, h: 7, mi: 15, off: -420 });
  assert.deepEqual(GB.parseStamp("2025-07-01T07:15"), { y: 2025, mo: 7, d: 1, h: 7, mi: 15 });
  assert.deepEqual(GB.parseStamp("01-OCT-2025 13:00"), { y: 2025, mo: 10, d: 1, h: 13, mi: 0 });
});

// ---------------------------------------------------------------------------
// Adversarial-review regressions (round 2)
// ---------------------------------------------------------------------------
test("parseStamp: a time RANGE is not an offset; ISO offsets (incl. a space before) still are", () => {
  const range = { y: 2025, mo: 7, d: 1, h: 13, mi: 0 };
  assert.deepEqual(GB.parseStamp("2025-07-01 13:00-14:00"), range);
  assert.deepEqual(GB.parseStamp("2025-07-01 13:00 - 14:00"), range);
  assert.deepEqual(GB.parseStamp("07/01/2025 1:00 PM-2:00 PM"), range);
  // out of the -12:00..+14:00 range: not an offset even with a "T"
  assert.deepEqual(GB.parseStamp("2025-07-01T13:00-14:00"), range);
  // offset forms
  assert.deepEqual(GB.parseStamp("2025-07-01T00:00:00 -0700"), { y: 2025, mo: 7, d: 1, h: 0, mi: 0, off: -420 });
  assert.deepEqual(GB.parseStamp("2025-07-01T00:00:00-07:00"), { y: 2025, mo: 7, d: 1, h: 0, mi: 0, off: -420 });
  assert.deepEqual(GB.parseStamp("2025-07-01T00:00-07:00"), { y: 2025, mo: 7, d: 1, h: 0, mi: 0, off: -420 });
  assert.deepEqual(GB.parseStamp("2025-07-01 00:00:00+05:30"), { y: 2025, mo: 7, d: 1, h: 0, mi: 0, off: 330 });

  // a whole generic CSV in the range style parses exactly as it did before offsets existed
  const rows = ["Interval,kWh"];
  for (let h = 0; h < 48; h++) {
    const d = h < 24 ? "2025-07-01" : "2025-07-02";
    rows.push(`${d} ${pad2(h % 24)}:00-${pad2((h + 1) % 24)}:00,1.000`);
  }
  const ls = GB.parse(rows.join("\n"));
  assert.equal(ls.meta.nHours, 48);
  assert.equal(ls.meta.start, "2025-07-01T00:00");
  assert.equal(ls.meta.intervalMinutes, 60);
  assert.ok(Math.abs(ls.meta.totalKwh - 48) < 1e-9);
  assert.doesNotMatch(ls.meta.notes.join(" | "), /UTC offset/);

  // and the space-before-offset form converts like any other offset
  const off = ["Timestamp,kWh"];
  for (let h = 0; h < 24; h++) off.push(`2025-07-01T${pad2(h)}:00:00 -0400,1.000`);
  const lo = GB.parse(off.join("\n"));
  assert.equal(lo.meta.start, "2025-06-30T21:00", "00:00 EDT is 21:00 PDT the day before");
  assert.equal(lo.meta.nHours, 24);
});

test("merge: a gap-FILLED hour in a later export never overwrites a real reading", () => {
  const gen = (d0, d1, val, hole) => {
    const rows = ["Timestamp,kWh"];
    for (let d = d0; d <= d1; d++) for (let h = 0; h < 24; h++) {
      if (hole && d * 24 + h >= hole[0] && d * 24 + h < hole[1]) continue;
      rows.push(`2025-01-${pad2(d)} ${pad2(h)}:00,${val(d, h).toFixed(3)}`);
    }
    return GB.parse(rows.join("\n"));
  };
  const A = gen(1, 20, (d, h) => (d === 15 && h >= 3 && h < 5 ? 9 : 1));        // real 9 kWh spike
  const B = gen(10, 29, () => 1, [15 * 24 + 3, 15 * 24 + 5]);                  // B missing it, fills 1
  assert.deepEqual(B.meta.gapsFilled.map((g) => g.ts), ["2025-01-15T03:00", "2025-01-15T04:00"]);
  for (const order of [[A, B], [B, A]]) {
    const m = GB.mergeLoadSets(order);
    assert.equal(m.kwh[m.ts.indexOf("2025-01-15T03:00")], 9);
    assert.equal(m.kwh[m.ts.indexOf("2025-01-15T04:00")], 9);
    assert.equal(m.meta.gapsFilled.length, 0, "the merged series has no filled hours");
    assert.equal(m.meta.quality.filled, 0);
  }
  // a fill no real reading covers survives, and is still listed
  const C = gen(21, 29, () => 1);
  const m = GB.mergeLoadSets([gen(1, 10, () => 1), B, C]);
  assert.deepEqual(m.meta.gapsFilled.map((g) => g.ts), ["2025-01-15T03:00", "2025-01-15T04:00"]);
  assert.equal(m.meta.quality.filled, 2);
  // overlap counts every shared hour; only metered-vs-metered hours are compared
  assert.match(m.meta.notes.join(" | "), /present in more than one export/);
});

test("merge: per-export NaN-gap notes are dropped when the merge closes the hole", () => {
  const gen = (d0, d1, hole) => {
    const rows = ["Timestamp,kWh"];
    for (let d = d0; d <= d1; d++) for (let h = 0; h < 24; h++) {
      if (hole && d * 24 + h >= hole[0] && d * 24 + h < hole[1]) continue;
      rows.push(`2025-01-${pad2(d)} ${pad2(h)}:00,1.000`);
    }
    return GB.parse(rows.join("\n"));
  };
  const B = gen(10, 29, [12 * 24, 14 * 24]);                                   // 48 h NaN
  assert.match(B.meta.notes.join(" | "), /consecutive hours missing/);
  const m = GB.mergeLoadSets([gen(1, 20), B]);
  assert.equal(m.meta.quality.missing, 0);
  assert.doesNotMatch(m.meta.notes.join(" | "), /consecutive hours missing/);
  const both = GB.mergeLoadSets([gen(1, 20, [12 * 24, 14 * 24]), B]);
  assert.equal(both.meta.quality.missing, 48);
  assert.equal(both.meta.notes.filter((n) => /consecutive hours missing/.test(n)).length, 1);
});

/**
 * A link-free ESPI feed built from parts: up(kind), rt({flow, uom}), ib(values, durSec).
 * Starts 2025-01-06 00:00 PST, well away from any DST date.
 */
const JAN_START = Date.UTC(2025, 0, 6, 8) / 1000;
const espiParts = {
  up: (kind) => `<entry><content><UsagePoint><ServiceCategory><kind>${kind}</kind></ServiceCategory></UsagePoint></content></entry>`,
  rt: ({ flow = 1, uom = 72 } = {}) => `<entry><content><ReadingType><flowDirection>${flow}</flowDirection>` +
    `<powerOfTenMultiplier>0</powerOfTenMultiplier><uom>${uom}</uom></ReadingType></content></entry>`,
  mr: () => `<entry><content><MeterReading/></content></entry>`,
  ib: (vals, dur = 3600, skip = () => false) => `<entry><content><IntervalBlock>` +
    vals.map((v, i) => skip(i) ? "" : `<IntervalReading><timePeriod><duration>${dur}</duration>` +
      `<start>${JAN_START + i * dur}</start></timePeriod><value>${v}</value></IntervalReading>`).join("") +
    `</IntervalBlock></content></entry>`,
  feed: (body) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<entry><content><LocalTimeParameters><dstOffset>3600</dstOffset><tzOffset>-28800</tzOffset>` +
    `</LocalTimeParameters></content></entry>${body}</feed>`,
};

test("ESPI without links: electric then gas UsagePoints listed first do not make the electric blocks gas", () => {
  const P = espiParts, H = 24 * 14;
  const elec = Array.from({ length: H }, () => 1000), gas = Array.from({ length: H }, () => 5);
  const xml = P.feed(P.up(0) + P.up(1) + P.mr() + P.rt() + P.ib(elec) + P.mr() + P.rt({ uom: 169 }) + P.ib(gas));
  const ls = GB.parse(xml);
  assert.equal(ls.meta.nHours, H);
  assert.ok(Math.abs(ls.meta.totalKwh - H) < 1e-9, `total ${ls.meta.totalKwh}: electricity only`);
  assert.match(ls.meta.notes.join(" | "), /uom 169 \(therm\)/);
});

test("ESPI forward + reverse channels: no duplicate notes; partial hours judged per channel", () => {
  const P = espiParts, H = 24 * 14;
  const fwd = Array.from({ length: H }, () => 1000);
  const rev = Array.from({ length: H }, (_, i) => (i % 24 >= 10 && i % 24 < 15 ? 2000 : 0));
  const ls = GB.parse(P.feed(P.up(0) + P.rt() + P.ib(fwd) + P.rt({ flow: 19 }) + P.ib(rev)));
  const notes = ls.meta.notes.join(" | ");
  assert.doesNotMatch(notes, /duplicated/);
  assert.ok(Math.abs(ls.meta.totalKwh - H) < 1e-9);
  assert.ok(Math.abs(sum(ls.exportKwh) - 14 * 5 * 2) < 1e-9);
  assert.match(notes, /flowDirection 19 readings were kept as export/);

  // 15-minute: one hour has 2 of 4 forward readings but all 4 reverse ones
  const Q = 96 * 4;
  const f15 = Array.from({ length: Q }, () => 250), r15 = Array.from({ length: Q }, () => 100);
  const hole = (i) => i === 96 + 40 || i === 96 + 41;            // Jan 7 10:00, quarters 0-1
  const q = GB.parse(P.feed(P.up(0) + P.rt() + P.ib(f15, 900, hole) + P.rt({ flow: 19 }) + P.ib(r15, 900)));
  const k = q.ts.indexOf("2025-01-07T10:00");
  assert.ok(Math.abs(q.kwh[k] - 1) < 1e-9, `import scaled to ${q.kwh[k]}`);
  assert.ok(Math.abs(q.exportKwh[k] - 0.4) < 1e-9, `export untouched at ${q.exportKwh[k]}`);
  assert.equal(q.meta.quality.partialHours, 1);
  assert.doesNotMatch(q.meta.notes.join(" | "), /duplicated/);
});

test("ESPI: a net-only feed does not claim flowDirection 19 readings", () => {
  const P = espiParts;
  const vals = Array.from({ length: 48 }, (_, i) => (i % 24 >= 10 && i % 24 < 15 ? -1000 : 1000));
  const ls = GB.parse(P.feed(P.up(0) + P.rt({ flow: 4 }) + P.ib(vals)));
  const notes = ls.meta.notes.join(" | ");
  assert.match(notes, /flowDirection 4 \(net\)/);
  assert.doesNotMatch(notes, /flowDirection 19/);
});

test("interval length: the file's own durations decide it; missing rows never make it coarse", () => {
  const pre = `Energy Usage Information\n"For location: X\n\nDetailed Usage\n` +
    `Date,Energy Consumption time Period Start,Energy Consumption time Period End,Delivered,Received\n`;
  const h12 = (h) => `${(h % 12) || 12}:00${h < 12 ? "AM" : "PM"}`;
  const row = (d, h, e, kwh) => `"01/${pad2(d)}/2025 ","01/${pad2(d)}/2025 ${h12(h)} ","${e} ","${kwh}","0.000"`;
  const end = (d, h) => (h === 23 ? `01/${pad2(d + 1)}/2025 12:00AM` : `01/${pad2(d)}/2025 ${h12(h + 1)}`);

  // every other hour missing, each row a stated 60 minutes: hourly, gaps filled
  const sparse = [];
  for (let d = 1; d <= 10; d++) for (let h = 0; h < 24; h += 2) sparse.push(row(d, h, end(d, h), "1.0"));
  const s = GB.parse(pre + sparse.join("\n"));
  assert.equal(s.meta.intervalMinutes, 60);
  assert.ok(s.meta.quality.filled > 100);

  // one 2-hour SCE row carrying 2 kWh is split, not doubled by a fill
  const rows = [];
  for (let d = 1; d <= 10; d++) for (let h = 0; h < 24; h++) {
    if (d === 5 && h === 3) continue;
    if (d === 5 && h === 2) { rows.push(row(d, 2, `01/05/2025 ${h12(4)}`, "2.0")); continue; }
    rows.push(row(d, h, end(d, h), "1.0"));
  }
  const ls = GB.parse(pre + rows.join("\n"));
  assert.equal(ls.meta.nHours, 240);
  assert.ok(Math.abs(ls.meta.totalKwh - 240) < 1e-9, `total ${ls.meta.totalKwh}`);
  assert.equal(ls.kwh[ls.ts.indexOf("2025-01-05T02:00")], 1);
  assert.equal(ls.kwh[ls.ts.indexOf("2025-01-05T03:00")], 1);
  assert.equal(ls.meta.quality.filled, 0);
  assert.match(ls.meta.notes.join(" | "), /1 reading covered more than one hour/);

  // no duration column at all: 15-minute SDG&E rows are read as 15-minute from the spacing
  const sd = ["Meter Number,Date,Start Time,Consumption,Generation,Net"];
  for (let h = 0; h < 72; h++) for (let qq = 0; qq < 4; qq++) {
    sd.push(`M1,2025-06-0${1 + Math.floor(h / 24)},${pad2(h % 24)}:${pad2(qq * 15)},0.250,0.000,0.250`);
  }
  const s15 = GB.parse(sd.join("\n"));
  assert.equal(s15.meta.intervalMinutes, 15);
  assert.doesNotMatch(s15.meta.notes.join(" | "), /duplicated/);
  assert.ok(Math.abs(s15.meta.totalKwh - 72) < 1e-9);
});
