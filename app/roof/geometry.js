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

/* ---------------------------------------------------------- module size */

/*
 * Module dimensions from the panel-watt knob.
 *
 * Reference module: 460 W at 1.134 m × 1.762 m (1.998 m²), the 108-half-cell
 * (54-cell-equivalent) 182 mm-wafer n-type format that dominates 2025-26 US
 * residential catalogues (e.g. 1762 × 1134 mm datasheets from the large
 * TOPCon / back-contact makers). That is 23.0 % on gross module area, at the
 * high end of 2026 residential stock (catalogue range ≈ 20.5–23 %). We anchor
 * the area-per-watt on this module rather than on a round 21.5 % so that the
 * 460 W default reproduces today's dimensions exactly and no saved result
 * moves; a 21.5 % rule would make the 460 W module 2.14 m² (7 % bigger).
 *
 *   area_m² = W × (1.134 × 1.762 / 460)      — constant area per watt
 *
 * Width class (the across-slope dimension, which is what packs into a face):
 *   ≤ 500 W  1.134 m — 182 mm cells: 108-half-cell (≈1.72–1.76 m long),
 *                      120-half-cell (≈1.90–1.95 m) and 144-half-cell
 *                      (≈2.28 m) formats all share the 1134 mm frame width.
 *   > 500 W  1.303 m — 210 mm cells: 100/110/120-half-cell formats on the
 *                      1303 mm frame, the usual route to 500 W+ modules.
 * Height = area / width, rounded to the millimetre like a datasheet. Area is
 * linear in W, so more watts never means a smaller module.
 */
const REF_W = 460, REF_WIDTH_M = 1.134, REF_HEIGHT_M = 1.762;
const WIDE_CLASS_W = 500, WIDE_WIDTH_M = 1.303;

/**
 * `{ widthM, heightM }` for a module of `w` watts (portrait: width across the
 * slope, height up it). Non-finite or non-positive input falls back to 460 W.
 */
export function panelDims(w) {
  const W = Number(w) > 0 && Number.isFinite(Number(w)) ? Number(w) : REF_W;
  const area = REF_WIDTH_M * REF_HEIGHT_M * (W / REF_W);
  const widthM = W > WIDE_CLASS_W ? WIDE_WIDTH_M : REF_WIDTH_M;
  const heightM = W === REF_W ? REF_HEIGHT_M : Math.round((area / widthM) * 1000) / 1000;
  return { widthM, heightM };
}

/**
 * Default module: the 460 W panel the app sizes with.
 *
 * `widthM` / `heightM` are readable but **non-enumerable** on purpose: the
 * roof builder does `{ ...DEFAULT_PANEL, ...opts.panel }` with only `{ w }`
 * from the panel-watt knob, and a spread skips non-enumerable keys, so the
 * merged object carries just `w` and `resolvePanel` derives the dimensions
 * from it. Were the 460 W dims copied in, a 400 W or 550 W knob would still be
 * laid out at 460 W size.
 */
export const DEFAULT_PANEL = Object.freeze(Object.defineProperties({ w: REF_W }, {
  widthM: { value: REF_WIDTH_M, enumerable: false },
  heightM: { value: REF_HEIGHT_M, enumerable: false },
}));

/**
 * The module the layout routines use. `w` is coerced to a number (a form field's "400"
 * is 400 W); a missing, non-numeric or non-positive `w` means 460 W. Explicit
 * `widthM`/`heightM` win (a caller who knows the datasheet); if only ONE of them is
 * given, the other is derived from the module's area at `w` (area / given side, to the
 * millimetre) rather than the given side being dropped; with neither, both come from
 * `panelDims(w)`.
 */
export function resolvePanel(panel) {
  const p = panel || DEFAULT_PANEL;
  const wn = Number(p.w);
  const w = wn > 0 && Number.isFinite(wn) ? wn : REF_W;
  const pos = (v) => {
    const x = Number(v);
    return x > 0 && Number.isFinite(x) ? x : null;
  };
  const widthM = pos(p.widthM), heightM = pos(p.heightM);
  if (widthM && heightM) return { w, widthM, heightM };
  const area = REF_WIDTH_M * REF_HEIGHT_M * (w / REF_W);
  const mm = (v) => Math.round(v * 1000) / 1000;
  if (widthM) return { w, widthM, heightM: mm(area / widthM) };
  if (heightM) return { w, widthM: mm(area / heightM), heightM };
  return { w, ...panelDims(w) };
}

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

/** Twice the signed shoelace area of an (x, y) ring: > 0 counter-clockwise. */
function signedArea2XY(xy) {
  let acc = 0;
  for (let i = 0, n = xy.length; i < n; i++) {
    const a = xy[i], b = xy[(i + 1) % n];
    acc += a[0] * b[1] - b[0] * a[1];
  }
  return acc;
}

/**
 * Plan-view (footprint) area of a polygon in m², by the shoelace formula in a
 * local metre frame taken at the polygon's latitude.
 *
 * A self-intersecting ring (a bow-tie from a mis-ordered click) has no single
 * meaningful area — the shoelace sum cancels the lobes against each other — so
 * it returns 0, the same as a degenerate polygon. Check `isSimplePolygon` to
 * tell the two apart.
 */
export function polygonAreaM2(points) {
  if (!points || points.length < 3) return 0;
  const f = localFrame(points);
  const xy = points.map(f.toXY);
  if (!isSimpleXY(xy)) return 0;
  return Math.abs(signedArea2XY(xy)) / 2;
}

/* ------------------------------------------------------- simple polygons */

/*
 * Tolerances are RELATIVE to the ring's extent. Lat/lon doubles near 34 N / 118 W carry
 * ~1e-14 deg of rounding (~1.5e-9 m once projected), so an exactly collinear triple read
 * off a map comes out of the local frame with a cross product of a few × 1e-9 × edge
 * length m². A fixed 1e-9 m² cut was below that noise, and degenerate (collinear) rings
 * on a ~1 m grid passed as simple. Scaling by the bounding-box diagonal D keeps the cut
 * above the noise at any size, and still far below anything a click can make: a vertex
 * within 1e-8 × D of a line is treated as on it (5e-8 m for a 5 m face).
 */
const REL_EPS = 1e-8;

/** { area, len } tolerances for a ring: area (cross products, m²) and length (m). */
function tolerancesXY(xy) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of xy) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const d = Math.max(Math.hypot(x1 - x0, y1 - y0), 1);   // never below the 1 m scale
  return { area: REL_EPS * d * d, len: REL_EPS * d };
}

function orient(a, b, c, eps) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) <= eps.area ? 0 : v > 0 ? 1 : -1;
}

/** c lies on segment ab, given that the three are collinear. */
function onSeg(a, b, c, eps) {
  const e = eps.len;
  return Math.min(a[0], b[0]) - e <= c[0] && c[0] <= Math.max(a[0], b[0]) + e &&
         Math.min(a[1], b[1]) - e <= c[1] && c[1] <= Math.max(a[1], b[1]) + e;
}

/** Closed-segment intersection test (touching and collinear overlap count). */
function segmentsIntersect(p1, p2, q1, q2, eps) {
  const o1 = orient(p1, p2, q1, eps), o2 = orient(p1, p2, q2, eps);
  const o3 = orient(q1, q2, p1, eps), o4 = orient(q1, q2, p2, eps);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(p1, p2, q1, eps)) || (o2 === 0 && onSeg(p1, p2, q2, eps)) ||
         (o3 === 0 && onSeg(q1, q2, p1, eps)) || (o4 === 0 && onSeg(q1, q2, p2, eps));
}

function isSimpleXY(xy) {
  const n = xy.length;
  if (n < 3) return false;
  if (!xy.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false;
  const eps = tolerancesXY(xy);
  for (let i = 0; i < n; i++) {
    const a = xy[i], b = xy[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= eps.len) return false;   // repeated vertex
    // Adjacent edge i+1 shares vertex b; it only crosses edge i if it doubles
    // back along the same line (a zero-width spike).
    const c = xy[(i + 2) % n];
    if (orient(a, b, c, eps) === 0 &&
        (c[0] - b[0]) * (a[0] - b[0]) + (c[1] - b[1]) * (a[1] - b[1]) > 0) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;                            // adjacent via the wrap
      if (segmentsIntersect(a, b, xy[j], xy[(j + 1) % n], eps)) return false;
    }
  }
  return true;
}

/**
 * True when the ring's edges meet only at shared endpoints of neighbouring
 * edges: no crossings (a bow-tie), no vertex touching a non-adjacent edge, no
 * repeated vertices, no zero-width spikes. Fewer than 3 points is not simple.
 * O(n²), which is nothing for the < 50 vertices of a traced roof face.
 */
export function isSimplePolygon(points) {
  if (!points || points.length < 3) return false;
  const f = localFrame(points);
  return isSimpleXY(points.map(f.toXY));
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
 * Unit outward normal of edge i (xy[i] → xy[i+1]) of an (x, y) ring.
 *
 * The side is taken from the ring's winding, not from the centroid: on a
 * counter-clockwise ring (positive signed area) the interior is to the left
 * of every edge, so outward is the right-hand normal (ey, −ex); on a clockwise
 * ring it is the left-hand one. This holds edge by edge on any simple polygon,
 * concave included — "away from the centroid" does not: on an L the centroid
 * sits beyond the inner corner and both notch edges point the wrong way.
 *
 * A ring with no net winding (a bow-tie, or a degenerate sliver) has no
 * outside; there we fall back to the away-from-centroid side so callers still
 * get a finite number. Such rings are flagged by `isSimplePolygon`.
 */
function outwardNormalXY(xy, i) {
  const n = xy.length;
  const a = xy[i], b = xy[(i + 1) % n];
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const len = Math.hypot(ex, ey) || 1;
  let nx = ey / len, ny = -ex / len;                 // right-hand normal
  const s2 = signedArea2XY(xy);
  if (Math.abs(s2) > tolerancesXY(xy).area) {
    if (s2 < 0) { nx = -nx; ny = -ny; }              // clockwise: outside is left
  } else {
    let cx = 0, cy = 0;
    for (const q of xy) { cx += q[0]; cy += q[1]; }
    cx /= n; cy /= n;
    if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
  }
  return [nx, ny];
}

/**
 * Azimuth the roof face points, derived from its gutter (low) edge: the
 * outward normal of that edge, i.e. the downslope direction. "Outward" comes
 * from the polygon's winding (see `outwardNormalXY`), so either winding works
 * and concave (L-shaped) footprints get the right side on every edge.
 *
 * @param {[number,number][]} polygon
 * @param {number|[number,number]} edge  edge index, or a [i, j] vertex pair
 * @returns {number} degrees clockwise from north, [0, 360)
 */
export function azimuthFromGutter(polygon, edge) {
  const i = edgeIndexOf(polygon, edge);
  const f = localFrame(polygon);
  const [nx, ny] = outwardNormalXY(polygon.map(f.toXY), i);
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
 * A self-intersecting trace reaches here as area 0 (`polygonAreaM2` refuses
 * it), so it counts 0 modules. Callers holding the polygon can pass it as
 * `areaM2` instead of a number and get the same check directly.
 *
 * @param {number|[number,number][]} areaM2  footprint (as seen from above /
 *        on the map), m² — or the footprint polygon itself
 * @param {number} tiltDeg  roof pitch in degrees
 * @param {{w?:number, widthM?:number, heightM?:number}} panel  dimensions,
 *        or just watts, from which `panelDims` derives them
 * @param {{setbackFraction?:number, usableFraction?:number}} opts
 *        `setbackFraction` is the share of the face **lost** to setbacks;
 *        `usableFraction` is the share **kept**. Either may be given.
 */
export function panelCount(areaM2, tiltDeg, panel = DEFAULT_PANEL, opts = {}) {
  if (Array.isArray(areaM2)) areaM2 = polygonAreaM2(areaM2);
  const p = resolvePanel(panel);
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
 * A self-intersecting polygon lays out nothing and the result carries
 * `invalid: 'self-intersecting'` (the key is absent on a valid face).
 *
 * @returns {{count:number, rects:[number,number][][], rows:number, cols:number,
 *            areaM2:number, planeAreaM2:number, invalid?:string}}
 */
export function layoutPanels(polygon, gutterEdgeIndex, tiltDeg, panel = DEFAULT_PANEL, opts = {}) {
  const empty = { count: 0, rects: [], rows: 0, cols: 0, areaM2: 0, planeAreaM2: 0 };
  if (!polygon || polygon.length < 3) return empty;
  if (!isSimplePolygon(polygon)) return { ...empty, invalid: 'self-intersecting' };

  const p = resolvePanel(panel);
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
  const out = outwardNormalXY(xy, gi);               // downhill, by winding
  const vx = -out[0], vy = -out[1];                  // uphill = inward normal

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
  panelDims, resolvePanel, isSimplePolygon,
  localFrame, polygonAreaM2, polygonCentroid, edgeBearing, norm360, angleDelta,
  edgeIndexOf, edgePair, azimuthFromGutter, planeAreaFromFootprint,
  footprintFromPlaneArea, usableFraction, panelCount, pitchOptions, pitchRatioFor,
  compassShort, compassName, shadeSteps, shadeStepFor, pointInPolygonXY,
  distToBoundaryXY, layoutPanels, m2ToFt2, ft2ToM2, mToFt, ftToM, clamp,
};
