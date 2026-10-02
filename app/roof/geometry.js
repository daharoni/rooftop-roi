/* ============================================================================
 * app/roof/geometry.js — roof geometry for the roof builder.
 *
 * Pure functions only: no DOM, no Leaflet, no fetch. Runs identically in the
 * browser and in `node --test` (tests/roof-geometry.test.mjs).
 *
 * Conventions
 *   - A point is `[lat, lon]` in degrees (Leaflet's LatLng tuple order).
 *   - A polygon is an array of points, not closed (no repeated last vertex),
 *     wound either way. Everything here is winding-agnostic.
 *   - An azimuth is degrees clockwise from true north: 0 = N, 90 = E,
 *     180 = S, 270 = W. This is the convention `Plane.azimuth` uses.
 *   - Distances are metres, areas square metres.
 *
 * Projection: an equirectangular (plate carrée) tangent frame taken at the
 * polygon's own mean latitude. Over a roof (tens of metres) the error against
 * a proper local ENU frame is far below a millimetre, and it keeps every
 * routine below reversible with `toLatLng`.
 * ========================================================================== */

const R_EARTH = 6371008.8;          // IUGG mean Earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const M2_PER_FT2 = 0.09290304;
export const M_PER_FT = 0.3048;
export const M_PER_IN = 0.0254;

/** Default module: the 460 W panel the app sizes with. */
export const DEFAULT_PANEL = { w: 460, widthM: 1.134, heightM: 1.762 };

/** Fire-code setback band used by the map layout, 18 inches. */
export const DEFAULT_SETBACK_M = 18 * M_PER_IN;   // 0.4572 m

/* ----------------------------------------------------------------- frame */

/**
 * Local metre frame for a polygon: x east, y north, origin at the polygon's
 * mean vertex. Returns `{ lat0, lon0, toXY, toLatLng }`.
 */
export function localFrame(points) {
  let lat0 = 0, lon0 = 0;
  for (const p of points) { lat0 += p[0]; lon0 += p[1]; }
  lat0 /= points.length; lon0 /= points.length;
  const kx = Math.cos(lat0 * D2R) * R_EARTH * D2R;
  const ky = R_EARTH * D2R;
  return {
    lat0, lon0,
    toXY: (p) => [(p[1] - lon0) * kx, (p[0] - lat0) * ky],
    toLatLng: (xy) => [lat0 + xy[1] / ky, lon0 + xy[0] / kx],
  };
}

/* ------------------------------------------------------------------ area */

/**
 * Plan-view (footprint) area of a polygon in m², by the shoelace formula in a
 * local metre frame taken at the polygon's latitude.
 */
export function polygonAreaM2(points) {
  if (!points || points.length < 3) return 0;
  const f = localFrame(points);
  const xy = points.map(f.toXY);
  let acc = 0;
  for (let i = 0, n = xy.length; i < n; i++) {
    const a = xy[i], b = xy[(i + 1) % n];
    acc += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(acc) / 2;
}

/** Centroid (area-weighted) of a polygon, as `[lat, lon]`. */
export function polygonCentroid(points) {
  const f = localFrame(points);
  const xy = points.map(f.toXY);
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0, n = xy.length; i < n; i++) {
    const p = xy[i], q = xy[(i + 1) % n];
    const cross = p[0] * q[1] - q[0] * p[1];
    a2 += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a2) < 1e-12) {            // degenerate: fall back to the mean
    return [f.lat0, f.lon0];
  }
  return f.toLatLng([cx / (3 * a2), cy / (3 * a2)]);
}

/* --------------------------------------------------------------- bearing */

/**
 * Initial great-circle bearing from `a` to `b`, degrees clockwise from north
 * in [0, 360).
 */
export function edgeBearing(a, b) {
  const f1 = a[0] * D2R, f2 = b[0] * D2R;
  const dl = (b[1] - a[1]) * D2R;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) * R2D);
}

/** Wrap any angle into [0, 360). */
export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Smallest signed difference a − b, in (−180, 180]. */
export function angleDelta(a, b) {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

/**
 * Accepts either a numeric edge index or a `[i, j]` vertex pair (the shape
 * `Plane.gutterEdge` uses) and returns the numeric index of the edge that
 * starts at vertex i.
 */
export function edgeIndexOf(polygon, edge) {
  const n = polygon.length;
  if (Array.isArray(edge)) {
    const [i, j] = edge;
    if ((i + 1) % n === j) return ((i % n) + n) % n;
    if ((j + 1) % n === i) return ((j % n) + n) % n;
    return ((i % n) + n) % n;
  }
  const i = Number(edge) || 0;
  return ((i % n) + n) % n;
}

/** The `[i, j]` vertex pair for edge index `i`, for `Plane.gutterEdge`. */
export function edgePair(polygon, edgeIndex) {
  const n = polygon.length;
  const i = edgeIndexOf(polygon, edgeIndex);
  return [i, (i + 1) % n];
}

/**
 * Azimuth the roof face points, derived from its gutter (low) edge: the
 * outward normal of that edge, i.e. the downslope direction. "Outward" is the
 * side away from the polygon's centroid, so the winding does not matter.
 *
 * @param {[number,number][]} polygon
 * @param {number|[number,number]} edge  edge index, or a [i, j] vertex pair
 * @returns {number} degrees clockwise from north, [0, 360)
 */
export function azimuthFromGutter(polygon, edge) {
  const n = polygon.length;
  const i = edgeIndexOf(polygon, edge);
  const f = localFrame(polygon);
  const a = f.toXY(polygon[i]);
  const b = f.toXY(polygon[(i + 1) % n]);
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const len = Math.hypot(ex, ey) || 1;

  // Both normals of the edge; pick the one pointing away from the centroid.
  let nx = ey / len, ny = -ex / len;
  const c = f.toXY(polygonCentroid(polygon));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  if (nx * (mx - c[0]) + ny * (my - c[1]) < 0) { nx = -nx; ny = -ny; }

  return norm360(Math.atan2(nx, ny) * R2D);   // x = east, y = north
}

/* ------------------------------------------------------------ pitch/area */

/**
 * Sloped area of a roof face from its plan-view footprint.
 * A tilted plane's shadow on the ground is `area · cos(tilt)`, so the plane
 * itself is `footprint / cos(tilt)`.
 */
export function planeAreaFromFootprint(footprintM2, tiltDeg) {
  const t = clamp(Number(tiltDeg) || 0, 0, 85);
  return footprintM2 / Math.cos(t * D2R);
}

/** Inverse of `planeAreaFromFootprint`. */
export function footprintFromPlaneArea(planeM2, tiltDeg) {
  const t = clamp(Number(tiltDeg) || 0, 0, 85);
  return planeM2 * Math.cos(t * D2R);
}

/**
 * Fraction of a roof face that modules can actually occupy once code
 * setbacks, vents, and racking edges are taken out.
 *
 * California residential solar (CRC R331 / CFC 1204, and most jurisdictions
 * that follow the IFC) requires a 3 ft clear pathway at the ridge on a roof
 * steeper than 2:12, an 18 in setback on hip and valley lines, and clearance
 * around vents and plumbing stacks. On a real pitched face that costs roughly
 * a quarter to a third of the surface, so **0.70** is the default here.
 *
 * A flat or near-flat roof (< 10°, about 2:12) is different: modules go on
 * tilted racking in rows, and the rows must be spaced apart or they shade each
 * other in winter. Row pitch of about 2× the module run is normal, which is
 * why the flat default is **0.55**.
 *
 * Both numbers are estimates and the user can override them in the UI.
 */
export function usableFraction(tiltDeg) {
  const t = Number(tiltDeg);
  if (Number.isFinite(t) && t < 10) return 0.55;
  return 0.70;
}

function resolveUsable(tiltDeg, opts = {}) {
  if (opts.usableFraction != null) return clamp(Number(opts.usableFraction), 0.05, 1);
  if (opts.setbackFraction != null) return clamp(1 - Number(opts.setbackFraction), 0.05, 1);
  return usableFraction(tiltDeg);
}

/**
 * How many modules fit on a face, from its **plan-view footprint** area.
 *
 * @param {number} areaM2   footprint (as seen from above / on the map), m²
 * @param {number} tiltDeg  roof pitch in degrees
 * @param {{widthM:number,heightM:number}} panel
 * @param {{setbackFraction?:number, usableFraction?:number}} opts
 *        `setbackFraction` is the share of the face **lost** to setbacks;
 *        `usableFraction` is the share **kept**. Either may be given.
 */
export function panelCount(areaM2, tiltDeg, panel = DEFAULT_PANEL, opts = {}) {
  const p = panel || DEFAULT_PANEL;
  const modArea = p.widthM * p.heightM;
  if (!(modArea > 0) || !(areaM2 > 0)) return 0;
  const plane = planeAreaFromFootprint(areaM2, tiltDeg);
  return Math.max(0, Math.floor((plane * resolveUsable(tiltDeg, opts)) / modArea));
}

/* ------------------------------------------------------------ pitch list */

/** The five presets the pitch picker offers, plus a free degrees entry. */
export function pitchOptions() {
  return [
    { label: 'Flat',        ratio: '≈1:12', deg: 5 },
    { label: 'Low',         ratio: '4:12',       deg: 18.4 },
    { label: 'Typical',     ratio: '6:12',       deg: 26.6 },
    { label: 'Steep',       ratio: '9:12',       deg: 36.9 },
    { label: 'Very steep',  ratio: '12:12',      deg: 45 },
  ];
}

/** Nearest preset ratio label for an arbitrary tilt, e.g. 27 → "6:12". */
export function pitchRatioFor(tiltDeg) {
  const rise = Math.round(Math.tan(clamp(Number(tiltDeg) || 0, 0, 80) * D2R) * 12);
  return `${rise}:12`;
}

/* ---------------------------------------------------------- compass words */

const COMPASS16 = [
  ['N', 'north'], ['NNE', 'north-northeast'], ['NE', 'northeast'], ['ENE', 'east-northeast'],
  ['E', 'east'], ['ESE', 'east-southeast'], ['SE', 'southeast'], ['SSE', 'south-southeast'],
  ['S', 'south'], ['SSW', 'south-southwest'], ['SW', 'southwest'], ['WSW', 'west-southwest'],
  ['W', 'west'], ['WNW', 'west-northwest'], ['NW', 'northwest'], ['NNW', 'north-northwest'],
];

/** Short compass point for an azimuth, e.g. 157 → "SSE". */
export function compassShort(az) {
  return COMPASS16[Math.round(norm360(az) / 22.5) % 16][0];
}

/** Compass point in words, e.g. 157 → "south-southeast". */
export function compassName(az) {
  return COMPASS16[Math.round(norm360(az) / 22.5) % 16][1];
}

/* ------------------------------------------------------------- shade steps */

/** The four-step shade picker. `loss` is the annual fraction of output lost. */
export function shadeSteps() {
  return [
    { key: 'none',     label: 'None',     loss: 0,    note: 'Open sky most of the day' },
    { key: 'light',    label: 'Light',    loss: 0.05, note: 'A chimney, a vent, a distant tree' },
    { key: 'moderate', label: 'Moderate', loss: 0.15, note: 'A tree or neighbour clips the morning or evening' },
    { key: 'heavy',    label: 'Heavy',    loss: 0.30, note: 'Shaded for hours every day' },
  ];
}

/** Nearest shade step for a loss fraction. */
export function shadeStepFor(loss) {
  const steps = shadeSteps();
  let best = steps[0];
  for (const s of steps) if (Math.abs(s.loss - loss) < Math.abs(best.loss - loss)) best = s;
  return best;
}

/* -------------------------------------------------------------- polygons */

/** Ray-cast point-in-polygon in a flat (x, y) frame. */
export function pointInPolygonXY(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to a polygon's boundary, same (x, y) frame. */
export function distToBoundaryXY(pt, poly) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = segDist(pt, poly[i], poly[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? clamp((wx * vx + wy * vy) / len2, 0, 1) : 0;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/* ---------------------------------------------------------- panel layout */

/**
 * Lay portrait modules out on a traced face, in rows parallel to the gutter,
 * working up the slope from the gutter toward the ridge.
 *
 * The polygon is the roof's **footprint** (what you see on the satellite
 * photo), so a portrait module's up-slope run foreshortens to
 * `heightM · cos(tilt)` in plan view while its width is unchanged.
 *
 * A module is kept when all four of its corners sit inside the polygon and at
 * least `setbackM` (18 in by default) away from every polygon edge — the code
 * setback band at the ridge, eaves, hips and valleys. This is deliberately
 * approximate: it is a planning estimate, not a permit set.
 *
 * @returns {{count:number, rects:[number,number][][], rows:number, cols:number,
 *            areaM2:number, planeAreaM2:number}}
 */
export function layoutPanels(polygon, gutterEdgeIndex, tiltDeg, panel = DEFAULT_PANEL, opts = {}) {
  const empty = { count: 0, rects: [], rows: 0, cols: 0, areaM2: 0, planeAreaM2: 0 };
  if (!polygon || polygon.length < 3) return empty;

  const p = panel || DEFAULT_PANEL;
  const setback = opts.setbackM != null ? Number(opts.setbackM) : DEFAULT_SETBACK_M;
  const rowGap = opts.rowGapM != null ? Number(opts.rowGapM) : 0.02;
  const colGap = opts.colGapM != null ? Number(opts.colGapM) : 0.02;
  const max = opts.max != null ? Number(opts.max) : Infinity;

  const tilt = clamp(Number(tiltDeg) || 0, 0, 85);
  const modS = p.widthM;                             // across the slope
  const modT = p.heightM * Math.cos(tilt * D2R);     // up the slope, in plan view
  if (!(modS > 0) || !(modT > 0)) return empty;

  const f = localFrame(polygon);
  const xy = polygon.map(f.toXY);
  const n = xy.length;
  const gi = edgeIndexOf(polygon, gutterEdgeIndex);
  const a = xy[gi], b = xy[(gi + 1) % n];

  const ex = b[0] - a[0], ey = b[1] - a[1];
  const elen = Math.hypot(ex, ey);
  if (!(elen > 0)) return empty;
  const ux = ex / elen, uy = ey / elen;              // along the gutter
  let vx = -uy, vy = ux;                             // one of the two normals
  const c = f.toXY(polygonCentroid(polygon));
  if (vx * (c[0] - a[0]) + vy * (c[1] - a[1]) < 0) { vx = -vx; vy = -vy; }  // point uphill

  // Polygon in gutter-aligned coordinates: s along the gutter, t up the slope.
  const st = xy.map((q) => {
    const dx = q[0] - a[0], dy = q[1] - a[1];
    return [dx * ux + dy * uy, dx * vx + dy * vy];
  });
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const q of st) {
    if (q[0] < sMin) sMin = q[0];
    if (q[0] > sMax) sMax = q[0];
    if (q[1] < tMin) tMin = q[1];
    if (q[1] > tMax) tMax = q[1];
  }

  // Centre the columns in the face so the array reads as deliberate.
  const sSpan = sMax - sMin - 2 * setback;
  const cols = Math.floor((sSpan + colGap) / (modS + colGap));
  if (cols < 1) return { ...empty, areaM2: polygonAreaM2(polygon) };
  const arrayW = cols * modS + (cols - 1) * colGap;
  const s0 = sMin + (sMax - sMin - arrayW) / 2;

  const tSpan = tMax - tMin - 2 * setback;
  const rows = Math.max(0, Math.floor((tSpan + rowGap) / (modT + rowGap)));
  const t0 = tMin + setback;

  const rects = [];
  outer:
  for (let r = 0; r < rows; r++) {
    const t = t0 + r * (modT + rowGap);
    for (let col = 0; col < cols; col++) {
      const s = s0 + col * (modS + colGap);
      const corners = [[s, t], [s + modS, t], [s + modS, t + modT], [s, t + modT]];
      let ok = true;
      for (const cn of corners) {
        const q = [a[0] + cn[0] * ux + cn[1] * vx, a[1] + cn[0] * uy + cn[1] * vy];
        if (!pointInPolygonXY(q, xy) || distToBoundaryXY(q, xy) < setback - 1e-6) { ok = false; break; }
      }
      if (!ok) continue;
      rects.push(corners.map((cn) =>
        f.toLatLng([a[0] + cn[0] * ux + cn[1] * vx, a[1] + cn[0] * uy + cn[1] * vy])));
      if (rects.length >= max) break outer;
    }
  }

  const areaM2 = polygonAreaM2(polygon);
  return {
    count: rects.length,
    rects,
    rows,
    cols,
    areaM2,
    planeAreaM2: planeAreaFromFootprint(areaM2, tilt),
  };
}

/* ----------------------------------------------------------------- units */

export function m2ToFt2(m2) { return m2 / M2_PER_FT2; }
export function ft2ToM2(ft2) { return ft2 * M2_PER_FT2; }
export function mToFt(m) { return m / M_PER_FT; }
export function ftToM(ft) { return ft * M_PER_FT; }

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export default {
  M2_PER_FT2, M_PER_FT, M_PER_IN, DEFAULT_PANEL, DEFAULT_SETBACK_M,
  localFrame, polygonAreaM2, polygonCentroid, edgeBearing, norm360, angleDelta,
  edgeIndexOf, edgePair, azimuthFromGutter, planeAreaFromFootprint,
  footprintFromPlaneArea, usableFraction, panelCount, pitchOptions, pitchRatioFor,
  compassShort, compassName, shadeSteps, shadeStepFor, pointInPolygonXY,
  distToBoundaryXY, layoutPanels, m2ToFt2, ft2ToM2, mToFt, ftToM, clamp,
};
