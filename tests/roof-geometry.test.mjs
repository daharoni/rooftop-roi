/* Tests for app/roof/geometry.js — the pure half of the roof builder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import G, {
  polygonAreaM2, polygonCentroid, edgeBearing, azimuthFromGutter, planeAreaFromFootprint,
  usableFraction, panelCount, layoutPanels, pitchOptions, pointInPolygonXY, localFrame,
  compassShort, compassName, edgePair, edgeIndexOf, m2ToFt2, DEFAULT_PANEL,
  isSimplePolygon, panelDims, resolvePanel,
} from '../app/roof/geometry.js';

const LAT = 34.15;           // the reference site, Agoura Hills
const LON = -118.75;
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

/* ------------------------------------------------- concave / winding */

/** A thin L (4 m arms, 30 m long), counter-clockwise, in local metres. Its
 *  centroid sits out past the inner corner, so the old "away from the
 *  centroid" rule picked the wrong side for both notch edges (2 and 3). */
const L_XY = [[0, 0], [30, 0], [30, 4], [4, 4], [4, 30], [0, 30]];

test('azimuthFromGutter: L-shape notch edges face into the notch (CCW and CW)', () => {
  const f = localFrame([[LAT, LON]]);
  const ccw = L_XY.map(f.toLatLng);
  // Confirm the centroid really is on the wrong side of edge 2, so this test bites.
  const c = f.toXY(polygonCentroid(ccw));
  assert.ok(c[1] > 4 && c[0] > 4, 'centroid is out in the notch, beyond the inner corner');
  const want = [180, 90, 0, 90, 0, 270];         // outward normal of each edge
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(G.angleDelta(azimuthFromGutter(ccw, i), want[i])) < 0.5,
      `CCW edge ${i}: got ${azimuthFromGutter(ccw, i)}, want ${want[i]}`);
  }
  // Same ring wound clockwise: edge k of the reversed ring is edge 4-k reversed.
  const cw = [...ccw].reverse();
  for (let i = 0; i < 6; i++) {
    const orig = (6 + 4 - i) % 6;
    assert.ok(Math.abs(G.angleDelta(azimuthFromGutter(cw, i), want[orig])) < 0.5,
      `CW edge ${i}: got ${azimuthFromGutter(cw, i)}, want ${want[orig]}`);
  }
  assert.ok(Math.abs(azimuthFromGutter(cw, [3, 2]) - 0) < 0.5 ||
            Math.abs(azimuthFromGutter(cw, [3, 2]) - 360) < 0.5, 'pair form on a CW ring');
});

test('azimuthFromGutter: rectangle unchanged in both windings (no regression)', () => {
  const r = rectAt(LAT, LON, 100, 60);
  const rev = [...r].reverse();          // rev edge k = r edge (2-k) mod 4, reversed
  const want = [180, 90, 0, 270];
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(G.angleDelta(azimuthFromGutter(r, i), want[i])) < 0.5);
    assert.ok(Math.abs(G.angleDelta(azimuthFromGutter(rev, i), want[(4 + 2 - i) % 4])) < 0.5);
  }
});

test('layoutPanels: on an L with a notch-edge gutter, rows climb away from the notch', () => {
  const f = localFrame([[LAT, LON]]);
  const L = [[0, 0], [30, 0], [30, 8], [8, 8], [8, 30], [0, 30]].map(f.toLatLng);
  for (const ring of [L, [...L].reverse()]) {
    const gutter = 2;      // the y = 8 inner edge: index 2 in both windings (k ↔ 4−k)
    const out = layoutPanels(ring, gutter, 26.6, PANEL);
    assert.ok(out.count > 0, 'the 8 m arm takes modules');
    const poly = ring.map(f.toXY);
    for (const rect of out.rects) {
      const p = rect.map(f.toXY);
      assert.ok(p[3][1] - p[0][1] < 0, 'uphill runs south, away from the notch gutter');
      for (const c of p) assert.ok(pointInPolygonXY(c, poly));
    }
  }
});

/* ------------------------------------------------------- self-intersection */

test('isSimplePolygon: bow-tie, spike and repeat are not simple; rect, L, triangle are', () => {
  const f = localFrame([[LAT, LON]]);
  const ll = (pts) => pts.map(f.toLatLng);
  assert.equal(isSimplePolygon(rectAt(LAT, LON, 10, 6)), true);
  assert.equal(isSimplePolygon([...rectAt(LAT, LON, 10, 6)].reverse()), true);
  assert.equal(isSimplePolygon(ll(L_XY)), true);
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 0], [5, 8]])), true);
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 10], [10, 0], [0, 10]])), false, 'bow-tie');
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 0], [10, 10], [10, 5], [0, 10]])), false, 'spike back along an edge');
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 0], [10, 0], [0, 10]])), false, 'repeated vertex');
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 5]])), false, 'touching at a vertex');
  assert.equal(isSimplePolygon(ll([[0, 0], [10, 0]])), false);
  assert.equal(isSimplePolygon(null), false);
});

test('isSimplePolygon: exactly collinear rings read off a lat/lon grid are not simple', () => {
  // Integer points on a 1e-5 deg (~1 m) grid, as a map click would give. Lat/lon rounding
  // left these collinear cases a few 1e-9 m² off zero, above the old fixed 1e-9 m² cut.
  const grid = (pts, step = 1e-5) => pts.map(([x, y]) => [LAT + y * step, LON - 0.01 + x * step]);
  const bad = {
    'all on one line': [[2, 2], [3, 3], [1, 1], [3, 1]],
    'flat triangle': [[2, 17], [16, 3], [9, 10]],
    'vertex on a non-adjacent edge': [[4, 0], [4, 2], [2, 4], [4, 5], [0, 3]],
  };
  for (const [name, pts] of Object.entries(bad)) {
    assert.equal(isSimplePolygon(grid(pts)), false, name);
    assert.equal(isSimplePolygon(grid([...pts].reverse())), false, `${name} (reversed)`);
  }
  // Genuine shapes on the same grid stay simple, including a shallow ridge vertex.
  assert.equal(isSimplePolygon(grid([[0, 0], [4, 0], [4, 3], [0, 3]])), true);
  assert.equal(isSimplePolygon(grid([[0, 0], [10, 0], [10, 1], [5, 2], [0, 1]])), true);
  assert.equal(isSimplePolygon(grid([[0, 0], [1000, 0], [1000, 1], [0, 1]], 1e-6)), true, 'long thin');
  // And at a 1 cm grid.
  assert.equal(isSimplePolygon(grid([[0, 0], [4, 0], [4, 3], [0, 3]], 1e-7)), true);
  assert.equal(isSimplePolygon(grid([[0, 0], [2, 2], [4, 4]], 1e-7)), false);
});

test('self-intersecting traces are invalid: area 0, count 0, layout flagged', () => {
  const f = localFrame([[LAT, LON]]);
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]].map(f.toLatLng);
  assert.equal(polygonAreaM2(bow), 0);
  assert.equal(panelCount(polygonAreaM2(bow), 26.6, PANEL), 0);
  assert.equal(panelCount(bow, 26.6, PANEL), 0, 'polygon form');
  const out = layoutPanels(bow, 0, 26.6, PANEL);
  assert.equal(out.count, 0);
  assert.deepEqual(out.rects, []);
  assert.equal(out.invalid, 'self-intersecting');
  assert.ok(Number.isFinite(azimuthFromGutter(bow, 0)), 'azimuth stays a number');
  // A valid face carries no `invalid` key, and the polygon form of panelCount agrees.
  const r = rectAt(LAT, LON, 10, 6);
  assert.equal('invalid' in layoutPanels(r, 0, 26.6, PANEL), false);
  assert.equal(panelCount(r, 26.6, PANEL), panelCount(polygonAreaM2(r), 26.6, PANEL));
});

/* ---------------------------------------------------------- module size */

test('panelDims: 460 W reproduces the reference module exactly', () => {
  assert.deepEqual(panelDims(460), { widthM: 1.134, heightM: 1.762 });
  assert.equal(DEFAULT_PANEL.widthM, 1.134);
  assert.equal(DEFAULT_PANEL.heightM, 1.762);
  assert.deepEqual(panelDims(undefined), panelDims(460));
  assert.deepEqual(panelDims(-3), panelDims(460));
  assert.deepEqual(panelDims('abc'), panelDims(460));
});

test('panelDims: higher watts never give a smaller module; width class steps at 500 W', () => {
  let prev = 0;
  for (let w = 100; w <= 1000; w += 5) {          // the hash accepts 100–1000 W
    const d = panelDims(w);
    const area = d.widthM * d.heightM;
    assert.ok(area > prev, `${w} W area ${area} did not grow past ${prev}`);
    prev = area;
    assert.equal(d.widthM, w > 500 ? 1.303 : 1.134);
  }
  for (let w = 350; w <= 560; w += 5) {           // the knob's range
    const h = panelDims(w).heightM;
    assert.ok(h > 1.3 && h < 2.0, `${w} W height ${h} m is not a plausible module`);
  }
  // Area tracks watts at the reference 23 % gross efficiency, to the mm rounding.
  for (const w of [400, 550]) {
    const d = panelDims(w);
    assert.ok(pct(d.widthM * d.heightM, 1.134 * 1.762 * w / 460) < 0.002);
  }
});

test('the panel-watt knob reaches the layout: {...DEFAULT_PANEL, w} derives dims', () => {
  // This is exactly what roofBuilder does with the app's { w: state.system.panelW }.
  const merged = (w) => ({ ...DEFAULT_PANEL, ...{ w } });
  assert.deepEqual(resolvePanel(merged(400)), { w: 400, ...panelDims(400) });
  assert.deepEqual(resolvePanel(merged(460)), { w: 460, widthM: 1.134, heightM: 1.762 });
  assert.deepEqual(resolvePanel(undefined), { w: 460, widthM: 1.134, heightM: 1.762 });
  // Explicit dimensions still win (dev.html passes them).
  assert.deepEqual(resolvePanel({ w: 400, widthM: 1.0, heightM: 1.7 }), { w: 400, widthM: 1.0, heightM: 1.7 });
  // A string watt value (a form field) is coerced, not carried through as text.
  assert.deepEqual(resolvePanel({ w: '400' }), { w: 400, ...panelDims(400) });
  assert.deepEqual(resolvePanel({ w: 'abc' }), { w: 460, widthM: 1.134, heightM: 1.762 });
  assert.equal(resolvePanel({ w: '400', widthM: 1.0, heightM: 1.7 }).w, 400);
  // One explicit side: the other comes from the module's area at w, not the side dropped.
  const area400 = 1.134 * 1.762 * 400 / 460;
  const onlyW = resolvePanel({ w: 400, widthM: 1.0 });
  assert.equal(onlyW.widthM, 1.0);
  assert.equal(onlyW.heightM, Math.round(area400 / 1.0 * 1000) / 1000);
  const onlyH = resolvePanel({ w: 460, heightM: 2.0 });
  assert.equal(onlyH.heightM, 2.0);
  assert.equal(onlyH.widthM, Math.round(1.134 * 1.762 / 2.0 * 1000) / 1000);

  // 460 W results do not move.
  assert.equal(panelCount(60, 26.6, merged(460)), panelCount(60, 26.6, PANEL));
  const r = rectAt(LAT, LON, 12, 8);
  assert.equal(layoutPanels(r, 0, 26.6, merged(460)).count, layoutPanels(r, 0, 26.6, PANEL).count);

  // Bigger modules, fewer of them; smaller, more.
  assert.ok(panelCount(60, 26.6, merged(400)) > panelCount(60, 26.6, merged(460)));
  assert.ok(panelCount(60, 26.6, merged(550)) < panelCount(60, 26.6, merged(460)));
  const big = layoutPanels(rectAt(LAT, LON, 16, 10), 0, 26.6, merged(550));
  const f = localFrame(rectAt(LAT, LON, 16, 10));
  for (const rect of big.rects) {
    const p = rect.map(f.toXY);
    assert.ok(Math.abs(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) - 1.303) < 1e-3, '550 W is the wide class');
  }
  // Installed kW from the area stays roughly flat across the knob (area ∝ W).
  const kw = (w) => panelCount(200, 26.6, merged(w)) * w / 1000;
  assert.ok(pct(kw(400), kw(460)) < 0.05 && pct(kw(550), kw(460)) < 0.05);
});

/* --------------------------------------------------------- module shape */

test('module exports a default object with every named function', () => {
  for (const k of ['polygonAreaM2', 'edgeBearing', 'azimuthFromGutter', 'planeAreaFromFootprint',
                   'usableFraction', 'panelCount', 'layoutPanels', 'pitchOptions',
                   'isSimplePolygon', 'panelDims', 'resolvePanel']) {
    assert.equal(typeof G[k], 'function', `default export is missing ${k}`);
  }
});
