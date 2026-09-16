/* Tests for app/roof/geometry.js — the pure half of the roof builder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import G, {
  polygonAreaM2, polygonCentroid, edgeBearing, azimuthFromGutter, planeAreaFromFootprint,
  usableFraction, panelCount, layoutPanels, pitchOptions, pointInPolygonXY, localFrame,
  compassShort, compassName, edgePair, edgeIndexOf, m2ToFt2, DEFAULT_PANEL,
} from '../app/roof/geometry.js';

const LAT = 34.145;           // the reference site, Agoura Hills
const LON = -118.76;
const PANEL = { w: 460, widthM: 1.134, heightM: 1.762 };

/** Build a rectangle `wM` east-west by `hM` north-south with its SW corner at
 *  (lat, lon), wound counter-clockwise starting at the SW corner. */
function rectAt(lat, lon, wM, hM) {
  const dLat = (hM / 6371008.8) * (180 / Math.PI);
  const dLon = (wM / (6371008.8 * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI);
  return [
    [lat, lon],                       // 0 SW
    [lat, lon + dLon],                // 1 SE
    [lat + dLat, lon + dLon],         // 2 NE
    [lat + dLat, lon],                // 3 NW
  ];
  // edge 0 = south (gutter), 1 = east, 2 = north, 3 = west
}

const pct = (a, b) => Math.abs(a - b) / b;

/* ------------------------------------------------------------------ area */

test('polygonAreaM2: known rectangle at 34°N within 1%', () => {
  const r = rectAt(LAT, LON, 100, 60);
  const a = polygonAreaM2(r);
  assert.ok(pct(a, 6000) < 0.01, `expected ~6000 m², got ${a.toFixed(1)}`);
});

test('polygonAreaM2: 10 m × 6 m face and a degenerate polygon', () => {
  assert.ok(pct(polygonAreaM2(rectAt(LAT, LON, 10, 6)), 60) < 0.01);
  assert.equal(polygonAreaM2([[LAT, LON], [LAT, LON + 0.001]]), 0);
  assert.equal(polygonAreaM2(null), 0);
});

test('polygonAreaM2 is winding-agnostic and matches ft² conversion', () => {
  const r = rectAt(LAT, LON, 100, 60);
  assert.ok(pct(polygonAreaM2([...r].reverse()), polygonAreaM2(r)) < 1e-9);
  assert.ok(pct(m2ToFt2(6000), 64583.5) < 0.001);
});

test('polygonCentroid of a rectangle sits at its middle', () => {
  const r = rectAt(LAT, LON, 100, 60);
  const c = polygonCentroid(r);
  const mid = [(r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2];
  assert.ok(Math.abs(c[0] - mid[0]) < 1e-9);
  assert.ok(Math.abs(c[1] - mid[1]) < 1e-9);
});

/* --------------------------------------------------------------- bearing */

test('edgeBearing: cardinal directions', () => {
  const r = rectAt(LAT, LON, 100, 60);
  assert.ok(Math.abs(edgeBearing(r[0], r[1]) - 90) < 0.1, 'SW→SE is east');
  assert.ok(Math.abs(edgeBearing(r[1], r[2]) - 0) < 0.1, 'SE→NE is north');
  assert.ok(Math.abs(edgeBearing(r[2], r[3]) - 270) < 0.1, 'NE→NW is west');
  assert.ok(Math.abs(edgeBearing(r[3], r[0]) - 180) < 0.1, 'NW→SW is south');
});

test('edgeBearing: a diagonal, and the reverse is 180° opposite', () => {
  const r = rectAt(LAT, LON, 100, 100);
  assert.ok(Math.abs(edgeBearing(r[0], r[2]) - 45) < 0.2, 'square diagonal is NE');
  const fwd = edgeBearing(r[0], r[2]);
  const back = edgeBearing(r[2], r[0]);
  const gap = ((back - fwd) % 360 + 360) % 360;
  assert.ok(Math.abs(gap - 180) < 0.2, `reverse bearing was ${gap.toFixed(3)}° away`);
});

/* ------------------------------------------------------- gutter azimuth */

test('azimuthFromGutter: south edge ≈ 180°, west edge ≈ 270°', () => {
  const r = rectAt(LAT, LON, 100, 60);
  assert.ok(Math.abs(azimuthFromGutter(r, 0) - 180) < 0.5, 'south gutter faces south');
  assert.ok(Math.abs(azimuthFromGutter(r, 3) - 270) < 0.5, 'west gutter faces west');
  assert.ok(Math.abs(azimuthFromGutter(r, 1) - 90) < 0.5, 'east gutter faces east');
  assert.ok(Math.abs(azimuthFromGutter(r, 2) - 0) < 0.5 ||
            Math.abs(azimuthFromGutter(r, 2) - 360) < 0.5, 'north gutter faces north');
});

test('azimuthFromGutter: independent of winding, and accepts an [i,j] pair', () => {
  const r = rectAt(LAT, LON, 100, 60);
  const rev = [...r].reverse();                       // south edge is now [2,3]
  assert.ok(Math.abs(azimuthFromGutter(rev, 2) - 180) < 0.5);
  assert.deepEqual(edgePair(r, 0), [0, 1]);
  assert.equal(edgeIndexOf(r, [0, 1]), 0);
  assert.equal(edgeIndexOf(r, [3, 0]), 3);
  assert.ok(Math.abs(azimuthFromGutter(r, [0, 1]) - 180) < 0.5);
});

test('azimuthFromGutter on a 45°-rotated square gives a diagonal facing', () => {
  const f = localFrame([[LAT, LON]]);
  const diamond = [[0, -20], [20, 0], [0, 20], [-20, 0]].map(f.toLatLng);
  // edge 0 runs from the south vertex to the east vertex; its outward normal is SE.
  assert.ok(Math.abs(azimuthFromGutter(diamond, 0) - 135) < 0.5);
});

/* ---------------------------------------------------------- plane / tilt */

test('planeAreaFromFootprint grows as 1/cos(tilt)', () => {
  assert.ok(pct(planeAreaFromFootprint(60, 0), 60) < 1e-9);
  assert.ok(pct(planeAreaFromFootprint(60, 26.6), 60 / Math.cos(26.6 * Math.PI / 180)) < 1e-9);
  assert.ok(pct(planeAreaFromFootprint(60, 26.6), 67.1) < 0.01);
  assert.ok(pct(planeAreaFromFootprint(60, 45), 84.85) < 0.01);
  assert.ok(planeAreaFromFootprint(60, 45) > planeAreaFromFootprint(60, 18.4));
});

test('footprintFromPlaneArea inverts planeAreaFromFootprint', () => {
  for (const t of [0, 5, 18.4, 26.6, 45]) {
    assert.ok(pct(G.footprintFromPlaneArea(planeAreaFromFootprint(60, t), t), 60) < 1e-9);
  }
});

test('usableFraction: 0.70 pitched, 0.55 flat', () => {
  assert.equal(usableFraction(26.6), 0.70);
  assert.equal(usableFraction(18.4), 0.70);
  assert.equal(usableFraction(45), 0.70);
  assert.equal(usableFraction(5), 0.55, 'flat roofs lose more to row spacing');
});

/* ----------------------------------------------------------- panel count */

test('panelCount: a 10 m × 6 m south face at 6:12 fits 20–24 modules', () => {
  const n = panelCount(60, 26.6, PANEL);
  assert.ok(n >= 20 && n <= 24, `expected 20–24 portrait 460 W modules, got ${n}`);
});

test('panelCount responds to tilt, setbacks and module size', () => {
  assert.ok(panelCount(60, 45, PANEL) > panelCount(60, 26.6, PANEL), 'steeper face is bigger');
  assert.ok(panelCount(60, 26.6, PANEL, { setbackFraction: 0.5 }) <
            panelCount(60, 26.6, PANEL), 'more setback, fewer panels');
  assert.equal(panelCount(60, 26.6, PANEL, { usableFraction: 0.70 }), panelCount(60, 26.6, PANEL));
  assert.equal(panelCount(0, 26.6, PANEL), 0);
  assert.equal(panelCount(-5, 26.6, PANEL), 0);
  assert.equal(panelCount(60, 26.6, DEFAULT_PANEL), panelCount(60, 26.6, undefined));
});

test('panelCount: a 2-car garage face (~22 ft × 20 ft) is about a dozen', () => {
  const m2 = G.ftToM(22) * G.ftToM(20);
  const n = panelCount(m2, 26.6, PANEL);
  assert.ok(n >= 10 && n <= 16, `expected roughly a dozen, got ${n}`);
});

/* ---------------------------------------------------------------- pitch */

test('pitchOptions has the five presets in rising order', () => {
  const o = pitchOptions();
  assert.equal(o.length, 5);
  assert.deepEqual(o.map((p) => p.label), ['Flat', 'Low', 'Typical', 'Steep', 'Very steep']);
  assert.deepEqual(o.map((p) => p.ratio), ['≈1:12', '4:12', '6:12', '9:12', '12:12']);
  assert.deepEqual(o.map((p) => p.deg), [5, 18.4, 26.6, 36.9, 45]);
  for (let i = 1; i < o.length; i++) assert.ok(o[i].deg > o[i - 1].deg);
  // The preset degrees really are those rise:run ratios.
  assert.ok(Math.abs(Math.atan(6 / 12) * 180 / Math.PI - 26.6) < 0.05);
  assert.ok(Math.abs(Math.atan(9 / 12) * 180 / Math.PI - 36.9) < 0.05);
  assert.equal(G.pitchRatioFor(26.6), '6:12');
  assert.equal(G.pitchRatioFor(45), '12:12');
});

/* --------------------------------------------------------------- compass */

test('compass words', () => {
  assert.equal(compassShort(180), 'S');
  assert.equal(compassName(180), 'south');
  assert.equal(compassName(157.5), 'south-southeast');
  assert.equal(compassName(0), 'north');
  assert.equal(compassName(359), 'north');
  assert.equal(compassShort(270), 'W');
  assert.equal(compassName(225), 'southwest');
});

/* ---------------------------------------------------------- panel layout */

test('layoutPanels: every rectangle lies inside the polygon', () => {
  const r = rectAt(LAT, LON, 12, 8);            // 12 m wide, 8 m deep
  const out = layoutPanels(r, 0, 26.6, PANEL);
  assert.ok(out.count > 0, 'laid out at least one module');
  assert.equal(out.rects.length, out.count);

  const f = localFrame(r);
  const poly = r.map(f.toXY);
  for (const rect of out.rects) {
    assert.equal(rect.length, 4);
    for (const c of rect) {
      assert.ok(pointInPolygonXY(f.toXY(c), poly), `corner ${c} outside the face`);
      assert.ok(G.distToBoundaryXY(f.toXY(c), poly) > 0.45 - 1e-3, 'corner inside the setback band');
    }
  }
});

test('layoutPanels: rows run parallel to the gutter and modules keep their size', () => {
  const r = rectAt(LAT, LON, 12, 8);
  const out = layoutPanels(r, 0, 26.6, PANEL);
  const f = localFrame(r);
  for (const rect of out.rects) {
    const p = rect.map(f.toXY);
    const across = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
    const up = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1]);
    assert.ok(Math.abs(across - PANEL.widthM) < 1e-3, 'module width preserved');
    // Up-slope run foreshortens by cos(tilt) in the plan view.
    assert.ok(Math.abs(up - PANEL.heightM * Math.cos(26.6 * Math.PI / 180)) < 1e-3);
    // Rows run east–west, parallel to the south gutter.
    assert.ok(Math.abs(p[1][1] - p[0][1]) < 1e-6, 'row is parallel to the gutter');
  }
});

test('layoutPanels: count is in the same ballpark as panelCount', () => {
  const r = rectAt(LAT, LON, 10, 6);
  const out = layoutPanels(r, 0, 26.6, PANEL);
  const est = panelCount(60, 26.6, PANEL);
  assert.ok(out.count > 0 && out.count <= est + 2,
    `layout ${out.count} vs estimate ${est}`);
  assert.ok(pct(out.areaM2, 60) < 0.01);
  assert.ok(pct(out.planeAreaM2, planeAreaFromFootprint(60, 26.6)) < 0.01);
});

test('layoutPanels: respects a max, and handles faces too small to build on', () => {
  const r = rectAt(LAT, LON, 12, 8);
  assert.equal(layoutPanels(r, 0, 26.6, PANEL, { max: 5 }).count, 5);
  const tiny = rectAt(LAT, LON, 1.5, 1.5);
  assert.equal(layoutPanels(tiny, 0, 26.6, PANEL).count, 0);
  assert.equal(layoutPanels([[LAT, LON], [LAT, LON + 1e-5]], 0, 26.6, PANEL).count, 0);
  assert.equal(layoutPanels(null, 0, 26.6, PANEL).count, 0);
});

test('layoutPanels: an L-shaped face clips modules to the notch', () => {
  const f = localFrame([[LAT, LON]]);
  // 14 m × 10 m with a 6 m × 5 m bite out of the north-east corner.
  const L = [[0, 0], [14, 0], [14, 5], [8, 5], [8, 10], [0, 10]].map(f.toLatLng);
  const out = layoutPanels(L, 0, 26.6, PANEL);
  const poly = L.map(f.toXY);
  assert.ok(out.count > 0);
  for (const rect of out.rects) {
    for (const c of rect) assert.ok(pointInPolygonXY(f.toXY(c), poly), 'module escaped the L');
  }
  const full = layoutPanels(f ? [[0, 0], [14, 0], [14, 10], [0, 10]].map(f.toLatLng) : null, 0, 26.6, PANEL);
  assert.ok(out.count < full.count, 'the notch costs modules');
});

test('layoutPanels: a west-facing gutter rotates the array', () => {
  const r = rectAt(LAT, LON, 12, 8);
  const out = layoutPanels(r, 3, 26.6, PANEL);      // west edge is the gutter
  assert.ok(out.count > 0);
  const f = localFrame(r);
  for (const rect of out.rects) {
    const p = rect.map(f.toXY);
    // Rows now run north–south.
    assert.ok(Math.abs(p[1][0] - p[0][0]) < 1e-6, 'row is parallel to the west gutter');
  }
});

/* ---------------------------------------------------------------- shade */

test('shade steps are the documented 0 / 5 / 15 / 30 %', () => {
  assert.deepEqual(G.shadeSteps().map((s) => s.loss), [0, 0.05, 0.15, 0.30]);
  assert.equal(G.shadeStepFor(0.16).key, 'moderate');
  assert.equal(G.shadeStepFor(0).key, 'none');
  assert.equal(G.shadeStepFor(0.9).key, 'heavy');
});

/* --------------------------------------------------------- module shape */

test('module exports a default object with every named function', () => {
  for (const k of ['polygonAreaM2', 'edgeBearing', 'azimuthFromGutter', 'planeAreaFromFootprint',
                   'usableFraction', 'panelCount', 'layoutPanels', 'pitchOptions']) {
    assert.equal(typeof G[k], 'function', `default export is missing ${k}`);
  }
});
