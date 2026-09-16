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
  for (const secret of ["DEMO HOUSEHOLD", "AGOURA HILLS", "8001754410", "SERVICE ACCOUNT"]) {
    assert.ok(!blob.includes(secret), `meta leaked ${secret}`);
  }
});

test("SCE: quality block reports hours / days / years / missing / filled", () => {
  const { merged } = demoLoadSet();
  assert.deepEqual(merged.meta.quality, {
    hours: 17734, days: 739, years: 17734 / 8766, missing: 0, filled: 0,
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
  assert.equal(GB.findZip("Account Number,8001754410"), null);
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
