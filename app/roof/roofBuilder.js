/* =============================================================================
 * app/roof/roofBuilder.js — the roof builder.
 *
 *   mountRoofBuilder(el, {
 *     site: { lat, lon } | null,
 *     planes: Plane[],
 *     panel: { w: 460, widthM: 1.134, heightM: 1.762 },
 *     onChange(planes),                       // every edit, Plane[] per ARCHITECTURE.md
 *     onSiteChange({ lat, lon }),             // the user set coordinates here
 *     onCalibration({ installerAnnualKwh }),  // proposal path only
 *   }) -> { destroy, setPlanes, setSite, setPath }
 *
 * Three ways in, one list out. The emitted objects are exactly the Plane shape
 * from ARCHITECTURE.md and nothing else — anything the UI needs to remember
 * (the feet the user typed, whether they renamed a face) lives in a side map
 * keyed by plane id, never on the plane itself.
 *
 * If `planes` arrives empty the builder seeds one south-facing starter face so
 * the panel opens in a working state, and emits it. Pass planes to override.
 *
 * Leaflet 1.9.4 and its stylesheet are fetched from cdnjs the first time the
 * map path is opened, so the other two paths cost no network at all.
 * ========================================================================== */

import G, {
  polygonAreaM2, polygonCentroid, azimuthFromGutter, edgePair, edgeIndexOf,
  planeAreaFromFootprint, usableFraction, panelCount, layoutPanels, pitchOptions,
  pitchRatioFor, compassShort, compassName, shadeSteps, shadeStepFor, norm360,
  localFrame, m2ToFt2, ftToM, mToFt, clamp, DEFAULT_PANEL,
} from './geometry.js';

const LEAFLET_VER = '1.9.4';
const LEAFLET_JS  = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VER}/leaflet.min.js`;
const LEAFLET_CSS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VER}/leaflet.min.css`;
const ESRI_TILES  = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR   = 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const CSS_HREF = new URL('./roof.css', import.meta.url).href;
const FACE_VARS = ['--s1', '--s2', '--s3', '--s7', '--s5', '--s4', '--s8', '--s6'];
const TAGS = 'ABCDEFGH';
const SVGNS = 'http://www.w3.org/2000/svg';
const D2R = Math.PI / 180;

/* ------------------------------------------------------------- tiny DOM */

function h(tag, attrs, ...kids) { return fill(document.createElement(tag), attrs, kids); }
function sv(tag, attrs, ...kids) { return fill(document.createElementNS(SVGNS, tag), attrs, kids); }

function fill(node, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === 'string' || typeof kid === 'number'
      ? document.createTextNode(String(kid)) : kid);
  }
  return node;
}

const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ensureStylesheet() {
  if (document.querySelector('link[data-rb-css]')) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href: CSS_HREF, 'data-rb-css': true }));
}

let leafletPromise = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-rb-leaflet]')) {
      document.head.appendChild(h('link', { rel: 'stylesheet', href: LEAFLET_CSS, 'data-rb-leaflet': true }));
    }
    const s = h('script', { src: LEAFLET_JS, async: true });
    s.onload = () => (window.L ? resolve(window.L) : reject(new Error('leaflet-missing')));
    s.onerror = () => { leafletPromise = null; reject(new Error('leaflet-unreachable')); };
    document.head.appendChild(s);
  });
  return leafletPromise;
}

/* ------------------------------------------------------------ plane model */

let idSeq = 0;
const nextId = () => `p${++idSeq}${Math.random().toString(36).slice(2, 5)}`;

const PLANE_KEYS = ['id', 'name', 'tilt', 'azimuth', 'maxPanels', 'shading', 'costAdder', 'polygon', 'gutterEdge'];

/** Emit-safe clone: exactly the nine Plane fields, nothing else. */
function toPlane(p) {
  return {
    id: p.id,
    name: p.name,
    tilt: round1(p.tilt),
    azimuth: round1(norm360(p.azimuth)),
    maxPanels: Math.max(0, Math.round(p.maxPanels || 0)),
    shading: { annual: clamp(Number(p.shading?.annual) || 0, 0, 0.95) },
    costAdder: Number(p.costAdder) || 0,
    polygon: p.polygon ? p.polygon.map((q) => [q[0], q[1]]) : null,
    gutterEdge: p.gutterEdge ? [p.gutterEdge[0], p.gutterEdge[1]] : null,
  };
}

function adoptPlane(raw) {
  const p = toPlane({
    id: raw.id || nextId(),
    name: raw.name || 'Roof face',
    tilt: raw.tilt ?? 26.6,
    azimuth: raw.azimuth ?? 180,
    maxPanels: raw.maxPanels ?? 0,
    shading: raw.shading,
    costAdder: raw.costAdder,
    polygon: Array.isArray(raw.polygon) ? raw.polygon : null,
    gutterEdge: Array.isArray(raw.gutterEdge) ? raw.gutterEdge : null,
  });
  if (/^p\d+$/.test(p.id)) idSeq = Math.max(idSeq, Number(p.id.slice(1)) || 0);
  return p;
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const baseName = (az) => `${cap(compassName(az))} face`;

/* ========================================================================== */

export function mountRoofBuilder(el, opts = {}) {
  ensureStylesheet();

  const panel = { ...DEFAULT_PANEL, ...(opts.panel || {}) };
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const onSiteChange = typeof opts.onSiteChange === 'function' ? opts.onSiteChange : () => {};
  const onCalibration = typeof opts.onCalibration === 'function' ? opts.onCalibration : () => {};

  const st = {
    path: 'simple',
    site: validSite(opts.site) ? { lat: +opts.site.lat, lon: +opts.site.lon } : null,
    planes: (opts.planes || []).map(adoptPlane),
    selectedId: null,
    installerAnnualKwh: null,
    editingSite: false,
  };
  /** UI-only memory, keyed by plane id. Never leaves the component. */
  const meta = new Map();
  const cleanups = [];

  /** "South face", then "South face 2" — two faces must never share a label. */
  function defaultName(az, exceptId) {
    const base = baseName(az);
    let name = base;
    for (let i = 2; st.planes.some((p) => p.id !== exceptId && p.name === name); i++) name = `${base} ${i}`;
    return name;
  }

  function metaOf(id) {
    if (!meta.has(id)) meta.set(id, { lengthFt: 24, widthFt: 20, renamed: false, countAuto: true, usable: null, hasSize: true });
    return meta.get(id);
  }
  const selected = () => st.planes.find((p) => p.id === st.selectedId) || null;

  function emit() { onChange(st.planes.map(toPlane)); }

  /* ------------------------------------------------------------ scaffold */

  const root = h('div', { class: 'rb', 'data-path': 'simple' });
  const siteBar = h('div', { class: 'rb-site' });
  const pathRow = h('div', { class: 'rb-paths', role: 'radiogroup', 'aria-label': 'How do you want to describe your roof?' });
  const editorSimple = h('div', { class: 'rb-editor' });
  const editorMap = h('div', { class: 'rb-editor', hidden: true });
  const editorQuote = h('div', { class: 'rb-editor', hidden: true });
  const facesRail = h('aside', { class: 'rb-faces' });
  const work = h('div', { class: 'rb-work' }, h('div', {}, editorSimple, editorMap, editorQuote), facesRail);
  root.append(siteBar, pathRow, work);
  el.replaceChildren(root);

  /* --------------------------------------------------------- path chooser */

  const PATHS = [
    { key: 'simple', title: 'Describe one face', sub: 'Fastest. Pick a direction, a slope and a size.', icon: iconGable },
    { key: 'map', title: 'Trace on the map', sub: 'Most accurate. Draw each face on the satellite photo.', icon: iconTrace },
    { key: 'quote', title: 'Copy an installer quote', sub: 'Already have a proposal? Type in its numbers.', icon: iconDoc },
  ];
  const pathBtns = PATHS.map((p) => {
    const b = h('button', {
      type: 'button', class: 'rb-path', role: 'radio', 'aria-checked': 'false', 'data-path': p.key,
      onclick: () => setPath(p.key),
      onkeydown: (e) => rovingKeys(e, pathBtns, (i) => setPath(PATHS[i].key)),
    }, p.icon(), h('b', { text: p.title }), h('span', { text: p.sub }));
    pathRow.appendChild(b);
    return b;
  });

  function setPath(key) {
    st.path = key;
    root.setAttribute('data-path', key);
    pathBtns.forEach((b, i) => {
      b.setAttribute('aria-checked', String(PATHS[i].key === key));
      b.tabIndex = PATHS[i].key === key ? 0 : -1;
    });
    editorSimple.hidden = key !== 'simple';
    editorMap.hidden = key !== 'map';
    editorQuote.hidden = key !== 'quote';
    if (key === 'simple') { ensureStarterFace(); syncSimple(); }
    if (key === 'map') openMap();
    if (key === 'quote') renderQuote();
    renderFaces();
  }

  /* -------------------------------------------------------------- site bar */

  function validSite(s) { return s && Number.isFinite(+s.lat) && Number.isFinite(+s.lon); }

  function renderSite() {
    siteBar.replaceChildren();
    if (st.site && !st.editingSite) {
      siteBar.append(
        h('div', { class: 'rb-site-txt' },
          'Roof location ', h('b', { class: 'mono', text: `${st.site.lat.toFixed(4)}, ${st.site.lon.toFixed(4)}` }),
          ' — used for the satellite view and the sun angles.'),
        h('button', { type: 'button', class: 'rb-btn', text: 'Change', onclick: () => { st.editingSite = true; renderSite(); } }));
      return;
    }
    const lat = h('input', { type: 'number', step: '0.0001', id: 'rb-lat', value: st.site ? st.site.lat : '', placeholder: '34.1450', 'aria-label': 'Latitude' });
    const lon = h('input', { type: 'number', step: '0.0001', id: 'rb-lon', value: st.site ? st.site.lon : '', placeholder: '-118.7600', 'aria-label': 'Longitude' });
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const s = { lat: parseFloat(lat.value), lon: parseFloat(lon.value) };
        if (!validSite(s)) return;
        st.site = s; st.editingSite = false;
        renderSite(); onSiteChange({ ...s });
        if (st.path === 'map') openMap();
      },
    },
      h('label', { for: 'rb-lat', class: 'rb-fine', text: 'Lat' }), lat,
      h('label', { for: 'rb-lon', class: 'rb-fine', text: 'Lon' }), lon,
      h('button', { type: 'submit', class: 'rb-btn rb-btn-primary', text: 'Use this location' }),
      st.site && h('button', { type: 'button', class: 'rb-btn', text: 'Cancel', onclick: () => { st.editingSite = false; renderSite(); } }));
    siteBar.append(
      h('div', { class: 'rb-site-txt' }, st.site ? 'Move the roof location.' : 'Set the roof location to trace on the satellite photo. Coordinates only here — search by address on the landing page.'),
      form);
  }

  /* ================================================== shared control parts */

  /** Pitch picker: five gable presets plus a degrees box. */
  function pitchPicker(onPick) {
    const opts = pitchOptions();
    const group = h('div', { class: 'rb-pitch', role: 'radiogroup', 'aria-label': 'Roof pitch' });
    const btns = opts.map((o, i) => {
      const b = h('button', {
        type: 'button', class: 'rb-pitch-opt', role: 'radio', 'aria-checked': 'false',
        'aria-label': `${o.label}, ${o.ratio.replace(':', ' in ')}`,
        onclick: () => onPick(o.deg),
        onkeydown: (e) => rovingKeys(e, btns, (j) => onPick(opts[j].deg)),
      }, gableIcon(o.deg), h('b', { text: o.label }), h('span', { text: o.ratio }));
      group.appendChild(b);
      return b;
    });
    const deg = h('input', { type: 'number', min: '0', max: '70', step: '0.5', id: uid('tilt'), oninput: () => { const v = parseFloat(deg.value); if (Number.isFinite(v)) onPick(clamp(v, 0, 70)); } });
    const ratio = h('span', { class: 'rb-fine' });
    const box = h('div', {}, group,
      h('div', { class: 'rb-fields', style: { marginTop: '10px' } },
        h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: deg.id, text: 'or degrees' }), deg),
        ratio));
    return {
      node: box,
      set(tilt) {
        btns.forEach((b, i) => {
          const on = Math.abs(opts[i].deg - tilt) < 0.25;
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        });
        if (!btns.some((b) => b.getAttribute('aria-checked') === 'true')) btns[0].tabIndex = 0;
        if (document.activeElement !== deg) deg.value = round1(tilt);
        ratio.textContent = `that is a ${pitchRatioFor(tilt)} pitch`;
      },
    };
  }

  /** Four-step shade picker plus a custom percentage. */
  function shadePicker(onPick) {
    const steps = shadeSteps();
    const group = h('div', { class: 'rb-shade', role: 'radiogroup', 'aria-label': 'How much shade falls on this face' });
    const btns = steps.map((s, i) => {
      const bar = h('div', { class: 'rb-shade-bar' }, [0, 1, 2, 3].map((k) => h('i', { class: k <= i ? 'on' : '' })));
      const b = h('button', {
        type: 'button', class: 'rb-shade-opt', role: 'radio', 'aria-checked': 'false',
        'aria-label': `${s.label} shade, ${Math.round(s.loss * 100)} percent lost. ${s.note}`,
        onclick: () => onPick(s.loss),
        onkeydown: (e) => rovingKeys(e, btns, (j) => onPick(steps[j].loss)),
      }, bar, h('b', { text: s.label }), h('span', { text: `${Math.round(s.loss * 100)}% lost` }));
      group.appendChild(b);
      return b;
    });
    const pct = h('input', { type: 'number', min: '0', max: '95', step: '1', id: uid('shade'), oninput: () => { const v = parseFloat(pct.value); if (Number.isFinite(v)) onPick(clamp(v, 0, 95) / 100); } });
    const note = h('p', { class: 'rb-shade-note' });
    const box = h('div', {}, group, note,
      h('div', { class: 'rb-fields', style: { marginTop: '8px' } },
        h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: pct.id, text: 'or % lost' }), pct)));
    return {
      node: box,
      set(loss) {
        steps.forEach((s, i) => {
          const on = Math.abs(s.loss - loss) < 0.005;
          btns[i].setAttribute('aria-checked', String(on));
          btns[i].tabIndex = on ? 0 : -1;
        });
        if (!btns.some((b) => b.getAttribute('aria-checked') === 'true')) btns[0].tabIndex = 0;
        if (document.activeElement !== pct) pct.value = Math.round(loss * 100);
        note.textContent = shadeStepFor(loss).note + '.';
      },
    };
  }

  /** The big "panels that fit" readout with a downward override. */
  function countBlock({ label, onSet, onReset }) {
    const big = h('div', { class: 'rb-count-big' });
    const sub = h('div', { class: 'rb-fine' });
    const input = h('input', { type: 'number', min: '0', step: '1', id: uid('count'), oninput: () => { const v = parseInt(input.value, 10); if (Number.isFinite(v)) onSet(Math.max(0, v)); } });
    const reset = h('button', { type: 'button', class: 'rb-btn-link', text: 'Use our estimate', onclick: onReset });
    const box = h('div', { class: 'rb-count' },
      h('div', {}, big, h('div', { class: 'rb-count-unit', text: label })),
      h('div', { class: 'rb-count-side' }, sub, reset),
      h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: input.id, text: 'Use fewer' }), input));
    return {
      node: box,
      set(count, estimate, note) {
        big.textContent = fmt(count);
        if (document.activeElement !== input) input.value = count;
        input.max = String(Math.max(estimate, count));
        sub.textContent = note;
        reset.hidden = count === estimate;
      },
    };
  }

  /* ============================================ path 1 — describe one face */

  function ensureStarterFace() {
    if (st.planes.length === 0) {
      const p = adoptPlane({ name: baseName(180), tilt: 26.6, azimuth: 180 });
      st.planes.push(p);
      st.selectedId = p.id;
      recountSimple(p);
      emit();
    }
    if (!selected()) st.selectedId = st.planes[st.planes.length - 1].id;
  }

  function footprintOf(p) {
    const m = metaOf(p.id);
    if (p.polygon) return polygonAreaM2(p.polygon);
    return ftToM(m.lengthFt) * ftToM(m.widthFt);
  }

  function estimateFor(p) {
    const m = metaOf(p.id);
    return panelCount(footprintOf(p), p.tilt, panel, m.usable != null ? { usableFraction: m.usable } : {});
  }

  function recountSimple(p) {
    const m = metaOf(p.id);
    if (m.countAuto) p.maxPanels = estimateFor(p);
  }

  const dial = makeDial((az) => {
    const p = selected(); if (!p) return;
    p.azimuth = az;
    const m = metaOf(p.id);
    if (!m.renamed) p.name = defaultName(az, p.id);
    syncSimple(); emit();
  }, () => (st.site ? st.site.lat : 34));

  const simplePitch = pitchPicker((deg) => {
    const p = selected(); if (!p) return;
    p.tilt = deg; recountSimple(p); syncSimple(); emit();
  });
  const simpleShade = shadePicker((loss) => {
    const p = selected(); if (!p) return;
    p.shading = { annual: loss }; syncSimple(); emit();
  });
  const simpleCount = countBlock({
    label: 'panels fit on this face',
    onSet: (n) => { const p = selected(); if (!p) return; metaOf(p.id).countAuto = false; p.maxPanels = n; syncSimple(); emit(); },
    onReset: () => { const p = selected(); if (!p) return; metaOf(p.id).countAuto = true; recountSimple(p); syncSimple(); emit(); },
  });

  const lenFt = h('input', { type: 'number', min: '1', step: '1', id: uid('len'), oninput: sizeChanged });
  const widFt = h('input', { type: 'number', min: '1', step: '1', id: uid('wid'), oninput: sizeChanged });
  const areaOut = h('div', { class: 'rb-measure' });
  function sizeChanged() {
    const p = selected(); if (!p) return;
    const m = metaOf(p.id);
    const L = parseFloat(lenFt.value), W = parseFloat(widFt.value);
    if (Number.isFinite(L) && L > 0) m.lengthFt = L;
    if (Number.isFinite(W) && W > 0) m.widthFt = W;
    m.hasSize = true;                       // the user has now told us the size
    recountSimple(p); syncSimple(); emit();
  }

  const nameIn = h('input', { type: 'text', id: uid('name'), oninput: () => { const p = selected(); if (!p) return; metaOf(p.id).renamed = true; p.name = nameIn.value || defaultName(p.azimuth, p.id); renderFaces(); emit(); } });
  const costIn = h('input', { type: 'number', min: '0', step: '50', id: uid('cost'), oninput: () => { const p = selected(); if (!p) return; p.costAdder = parseFloat(costIn.value) || 0; emit(); } });
  const usableIn = h('input', { type: 'number', min: '20', max: '100', step: '1', id: uid('usable'), oninput: () => { const p = selected(); if (!p) return; const v = parseFloat(usableIn.value); metaOf(p.id).usable = Number.isFinite(v) ? clamp(v / 100, 0.2, 1) : null; recountSimple(p); syncSimple(); emit(); } });

  const simpleHead = h('p', { class: 'rb-hint' });

  editorSimple.append(
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'Which way does this face look?' }), simpleHead),
      h('div', { class: 'rb-dial-row' }, dial.node, dial.readout)),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'How steep is it?' }),
        h('p', { class: 'rb-hint', text: 'Roofers name a pitch by how many inches it rises over 12 inches of run. If you have no idea, Typical is the commonest slope on an American house.' })),
      simplePitch.node),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'How big is it?' }),
        h('p', { class: 'rb-hint', text: 'Measure the way it looks from above — on a satellite photo, or pace it out on the ground. We add the slope back in for you.' })),
      h('div', { class: 'rb-fields' },
        h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: lenFt.id, text: 'Along the gutter (ft)' }), lenFt),
        h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: widFt.id, text: 'Gutter to ridge (ft)' }), widFt)),
      areaOut,
      h('div', { style: { marginTop: '12px' } }, simpleCount.node),
      h('details', { class: 'rb-more' },
        h('summary', { text: 'More options' }),
        h('div', { class: 'rb-fields' },
          h('div', { class: 'rb-field rb-field-md' }, h('label', { for: nameIn.id, text: 'Name this face' }), nameIn),
          h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: usableIn.id, text: 'Usable area (%)' }), usableIn),
          h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: costIn.id, text: 'Extra cost ($)' }), costIn)),
        h('p', { class: 'rb-fine', style: { marginTop: '8px' } , text: 'Usable area is what is left after fire-code setbacks — a 3 ft clear path at the ridge, 18 in along hips and valleys, and room around vents. 70% is typical on a pitched roof; a flat roof drops to about 55% because tilted rows have to be spaced apart.' }))),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'How much shade falls on it?' }),
        h('p', { class: 'rb-hint', text: 'Think about a clear day in June and again in December. Count anything that blocks the sky between mid-morning and mid-afternoon.' })),
      simpleShade.node),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-btn-row' },
        h('button', { type: 'button', class: 'rb-btn rb-btn-primary', text: 'Add another face', onclick: addSimpleFace }),
        h('button', { type: 'button', class: 'rb-btn', text: 'Trace this one on the map instead', onclick: () => setPath('map') }))),
  );

  function addSimpleFace() {
    const prev = selected();
    const az = prev ? norm360(prev.azimuth + 180) : 180;
    const p = adoptPlane({ name: baseName(az), tilt: prev ? prev.tilt : 26.6, azimuth: az });
    p.name = defaultName(az, p.id);
    const m = metaOf(p.id);
    if (prev) { const pm = metaOf(prev.id); m.lengthFt = pm.lengthFt; m.widthFt = pm.widthFt; }
    st.planes.push(p);
    st.selectedId = p.id;
    recountSimple(p);
    syncSimple(); renderFaces(); emit();
  }

  function syncSimple() {
    const p = selected();
    if (!p) return;
    const m = metaOf(p.id);
    dial.set(p.azimuth);
    simplePitch.set(p.tilt);
    simpleShade.set(p.shading.annual);
    simpleHead.textContent = st.planes.length > 1
      ? `Editing ${p.name}. Point the roof the way rain runs off it — downhill, toward the gutter.`
      : 'Point the roof the way rain runs off it — downhill, toward the gutter. The amber arc shows where the sun travels at your latitude.';
    if (document.activeElement !== lenFt) lenFt.value = round1(m.lengthFt);
    if (document.activeElement !== widFt) widFt.value = round1(m.widthFt);
    if (document.activeElement !== nameIn) nameIn.value = p.name;
    if (document.activeElement !== costIn) costIn.value = p.costAdder || 0;
    if (document.activeElement !== usableIn) usableIn.value = Math.round((m.usable ?? usableFraction(p.tilt)) * 100);

    const fp = footprintOf(p);
    const slope = planeAreaFromFootprint(fp, p.tilt);
    areaOut.replaceChildren(
      h('span', {}, 'Footprint ', h('b', { text: `${fmt(m2ToFt2(fp))} ft²` }), ` (${fmt(fp)} m²)`),
      h('span', {}, 'Roof surface ', h('b', { text: `${fmt(m2ToFt2(slope))} ft²` }), ` (${fmt(slope)} m²)`));
    const est = estimateFor(p);
    simpleCount.set(p.maxPanels, est, m.countAuto
      ? `At ${panel.w} W each, after setbacks. A 2-car-garage-sized face (22 × 20 ft) fits about 12.`
      : `You set this by hand. Our estimate for this size is ${fmt(est)}.`);
  }

  /* ================================================== path 2 — map tracer */

  const mapSteps = h('ol', { class: 'rb-steps' },
    stepLi('1', 'Click the corners', 'Go round one roof face. Click the first dot again to close it.'),
    stepLi('2', 'Click the gutter edge', 'The low edge, where rain runs off. That tells us which way the face points.'),
    stepLi('3', 'Set the pitch', 'Then we lay the panels out and count them.'));
  const mapTip = h('div', { class: 'rb-map-tip', hidden: true });
  const mapEl = h('div', { class: 'rb-map' });
  const mapNotice = h('div', { class: 'rb-notice', hidden: true });
  const mapMeasure = h('div', { class: 'rb-measure' });
  const mapDetail = h('div', { hidden: true });
  const mapToolbar = h('div', { class: 'rb-btn-row', style: { marginTop: '12px' } });

  const btnTrace = h('button', { type: 'button', class: 'rb-btn rb-btn-primary', text: 'Trace a face', onclick: startDraw });
  const btnUndo = h('button', { type: 'button', class: 'rb-btn', text: 'Undo last point', onclick: undoPoint, disabled: true });
  const btnDone = h('button', { type: 'button', class: 'rb-btn', text: 'Close the shape', onclick: () => closeDraft(), disabled: true });
  const btnCancel = h('button', { type: 'button', class: 'rb-btn', text: 'Cancel', onclick: cancelDraw, disabled: true });
  mapToolbar.append(btnTrace, btnUndo, btnDone, btnCancel);

  const mapPitch = pitchPicker((deg) => {
    const p = selected(); if (!p) return;
    p.tilt = deg; relayout(p); syncMapDetail(); emit();
  });
  const mapShade = shadePicker((loss) => {
    const p = selected(); if (!p) return;
    p.shading = { annual: loss }; syncMapDetail(); emit();
  });
  const mapCount = countBlock({
    label: 'panels laid out',
    onSet: (n) => { const p = selected(); if (!p) return; const m = metaOf(p.id); m.countAuto = false; p.maxPanels = Math.min(n, m.layoutMax ?? n); relayout(p, true); syncMapDetail(); emit(); },
    onReset: () => { const p = selected(); if (!p) return; metaOf(p.id).countAuto = true; relayout(p); syncMapDetail(); emit(); },
  });
  const mapFacing = h('p', { class: 'rb-hint' });
  const mapName = h('input', { type: 'text', id: uid('mname'), oninput: () => { const p = selected(); if (!p) return; metaOf(p.id).renamed = true; p.name = mapName.value || defaultName(p.azimuth, p.id); drawFace(p); renderFaces(); emit(); } });
  const mapCost = h('input', { type: 'number', min: '0', step: '50', id: uid('mcost'), oninput: () => { const p = selected(); if (!p) return; p.costAdder = parseFloat(mapCost.value) || 0; emit(); } });

  mapDetail.append(
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'How steep is this face?' }), mapFacing),
      mapPitch.node,
      h('div', { style: { marginTop: '12px' } }, mapCount.node),
      h('p', { class: 'rb-fine', style: { marginTop: '8px' }, text: 'Modules are placed 18 inches clear of every edge — the fire-code setback band at the ridge, eaves, hips and valleys. Vents and skylights are not in the photo, so treat the count as an upper bound.' })),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'How much shade falls on it?' })),
      mapShade.node,
      h('details', { class: 'rb-more' },
        h('summary', { text: 'More options' }),
        h('div', { class: 'rb-fields' },
          h('div', { class: 'rb-field rb-field-md' }, h('label', { for: mapName.id, text: 'Name this face' }), mapName),
          h('div', { class: 'rb-field rb-field-sm' }, h('label', { for: mapCost.id, text: 'Extra cost ($)' }), mapCost)))),
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-btn-row' },
        h('button', { type: 'button', class: 'rb-btn rb-btn-primary', text: 'Add another face', onclick: startDraw }))));

  editorMap.append(
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'Trace your roof on the satellite photo' }),
        h('p', { class: 'rb-hint', text: 'One face at a time — a face is a single flat slope, so a simple gable roof is two. Zoom in until you can see the shingles.' })),
      mapSteps,
      h('p', { class: 'rb-fine rb-lap-hint', style: { marginTop: '8px' }, text: 'Tracing is easier on a laptop, where you can click precisely. On a phone: pinch to zoom, then tap each corner.' }),
      h('div', { class: 'rb-map-wrap' }, mapEl, mapTip),
      mapToolbar, mapMeasure, mapNotice),
    mapDetail);

  function stepLi(n, title, body) {
    return h('li', {}, h('b', {}, h('i', { text: n }), title), h('span', { text: body }));
  }
  function setStep(n) {
    [...mapSteps.children].forEach((li, i) => {
      li.setAttribute('data-on', i + 1 === n ? '1' : '0');
      li.setAttribute('data-done', i + 1 < n ? '1' : '0');
    });
  }
  function tip(html) {
    if (!html) { mapTip.hidden = true; return; }
    mapTip.hidden = false;
    mapTip.innerHTML = html;
  }

  let L = null, map = null, tiles = null;
  let mapState = 'idle';          // idle | draw | gutter | edit
  let draft = [];                 // [lat,lng][] while drawing
  let draftLine = null, draftVerts = [];
  let edgeLines = [];
  const layers = new Map();       // plane id -> { poly, verts, arrow, arrowTag, tag, panels }
  let tilesSeen = 0, tileErrors = 0;

  function openMap() {
    if (!st.site) {
      mapNotice.hidden = false;
      mapNotice.replaceChildren(h('b', { text: 'Set the roof location first.' }),
        document.createTextNode(' The map needs coordinates before it can show your house.'));
      return;
    }
    if (map) { setTimeout(() => map.invalidateSize(), 0); return; }
    ensureLeaflet().then((lib) => { L = lib; buildMap(); }).catch(() => showOffline('lib'));
  }

  function buildMap() {
    map = L.map(mapEl, { zoomControl: false, doubleClickZoom: false, attributionControl: true })
      .setView([st.site.lat, st.site.lon], 20);
    L.control.zoom({ position: 'topright' }).addTo(map);
    tiles = L.tileLayer(ESRI_TILES, { maxZoom: 21, maxNativeZoom: 19, attribution: ESRI_ATTR, crossOrigin: true });
    tiles.on('tileload', () => { tilesSeen++; if (tilesSeen > 0) hideOffline(); });
    tiles.on('tileerror', () => { tileErrors++; if (tilesSeen === 0 && tileErrors >= 3) showOffline('tiles'); });
    tiles.addTo(map);
    map.on('click', onMapClick);
    map.on('dblclick', (e) => { if (mapState === 'draw') { L.DomEvent.stop(e); closeDraft(); } });
    st.planes.filter((p) => p.polygon).forEach(drawFace);
    setStep(1);
    tip('Press <b>Trace a face</b> to start.');
  }

  function showOffline(kind) {
    mapNotice.hidden = false;
    mapNotice.replaceChildren(
      h('b', { text: kind === 'lib' ? 'The map could not load.' : 'The satellite photos are not loading.' }),
      document.createTextNode(kind === 'lib'
        ? ' Leaflet is fetched from cdnjs, so this usually means no connection or a blocked CDN. Nothing else in the tool needs it.'
        : ' You are probably offline or behind a filter that blocks Esri. Everything else still works.'),
      h('div', {}, h('button', { type: 'button', class: 'rb-btn', text: 'Describe the face instead', onclick: () => setPath('simple') })));
  }
  function hideOffline() { if (mapNotice.textContent.includes('satellite')) mapNotice.hidden = true; }

  function faceColor(p) {
    const i = Math.max(0, st.planes.findIndex((q) => q.id === p.id)) % FACE_VARS.length;
    const v = getComputedStyle(root).getPropertyValue(FACE_VARS[i]).trim();
    return v || '#2a78d6';
  }
  function faceTag(p) {
    return TAGS[Math.max(0, st.planes.findIndex((q) => q.id === p.id)) % TAGS.length];
  }

  /* -- drawing ---------------------------------------------------------- */

  function startDraw() {
    if (!map) { openMap(); return; }
    cancelDraw();
    mapState = 'draw';
    draft = [];
    setStep(1);
    tip('Click each corner of <b>one</b> roof face. Click the first dot again, or double-click, to close it.');
    btnUndo.disabled = true; btnDone.disabled = true; btnCancel.disabled = false;
    mapDetail.hidden = true;
  }

  function cancelDraw() {
    draft = [];
    if (draftLine) { map.removeLayer(draftLine); draftLine = null; }
    draftVerts.forEach((m) => map.removeLayer(m));
    draftVerts = [];
    clearEdgeLines();
    if (mapState !== 'edit') { mapState = 'idle'; tip('Press <b>Trace a face</b> to start.'); setStep(1); }
    btnUndo.disabled = true; btnDone.disabled = true; btnCancel.disabled = true;
  }

  function onMapClick(e) {
    if (mapState !== 'draw') return;
    const pt = [e.latlng.lat, e.latlng.lng];
    if (draft.length >= 3) {
      const first = map.latLngToContainerPoint(L.latLng(draft[0]));
      if (first.distanceTo(map.latLngToContainerPoint(e.latlng)) < 14) { closeDraft(); return; }
    }
    draft.push(pt);
    redrawDraft();
  }

  function undoPoint() {
    if (mapState !== 'draw' || !draft.length) return;
    draft.pop();
    redrawDraft();
  }

  function redrawDraft() {
    if (draftLine) map.removeLayer(draftLine);
    draftVerts.forEach((m) => map.removeLayer(m));
    draftVerts = [];
    const col = getComputedStyle(root).getPropertyValue('--s1').trim() || '#2a78d6';
    if (draft.length > 1) draftLine = L.polyline(draft, { color: col, weight: 2, dashArray: '4 4' }).addTo(map);
    draft.forEach((pt, i) => {
      const m = L.marker(pt, {
        icon: L.divIcon({ className: '', html: `<div class="rb-vertex${i === 0 ? ' first' : ''}"></div>`, iconSize: [0, 0] }),
        keyboard: false,
      }).addTo(map);
      if (i === 0) m.on('click', (e) => { L.DomEvent.stop(e); if (draft.length >= 3) closeDraft(); });
      draftVerts.push(m);
    });
    btnUndo.disabled = draft.length === 0;
    btnDone.disabled = draft.length < 3;
    if (draft.length === 1) tip('Keep going — click the next corner.');
    if (draft.length >= 3) tip('Click the <b>first dot</b> to close the shape, or keep adding corners.');
  }

  function closeDraft() {
    if (draft.length < 3) return;
    const polygon = draft.slice();
    cancelDraw();
    const p = adoptPlane({ name: 'Roof face', tilt: 26.6, azimuth: 180, polygon });
    st.planes.push(p);
    st.selectedId = p.id;
    metaOf(p.id);
    drawFace(p);
    mapState = 'gutter';
    setStep(2);
    tip('Now click the <b>bottom edge</b> — the gutter, where rain runs off. Its downhill direction is the way this face points.');
    showEdgePicker(p);
    renderFaces();
    emit();
  }

  function clearEdgeLines() { edgeLines.forEach((l) => map.removeLayer(l)); edgeLines = []; }

  function showEdgePicker(p) {
    clearEdgeLines();
    const col = faceColor(p);
    const n = p.polygon.length;
    for (let i = 0; i < n; i++) {
      const seg = [p.polygon[i], p.polygon[(i + 1) % n]];
      const hit = L.polyline(seg, { color: col, weight: 16, opacity: 0.001, interactive: true }).addTo(map);
      const show = L.polyline(seg, { color: col, weight: 3, opacity: 0.9, interactive: false }).addTo(map);
      hit.on('mouseover', () => show.setStyle({ weight: 7, opacity: 1 }));
      hit.on('mouseout', () => show.setStyle({ weight: 3, opacity: 0.9 }));
      hit.on('click', (e) => { L.DomEvent.stop(e); pickGutter(p, i); });
      edgeLines.push(hit, show);
    }
  }

  function pickGutter(p, edgeIndex) {
    clearEdgeLines();
    p.gutterEdge = edgePair(p.polygon, edgeIndex);
    p.azimuth = round1(azimuthFromGutter(p.polygon, edgeIndex));
    const m = metaOf(p.id);
    if (!m.renamed) p.name = defaultName(p.azimuth, p.id);
    m.countAuto = true;
    relayout(p);
    mapState = 'edit';
    setStep(3);
    tip('Set the pitch below. Trace another face when you are ready.');
    mapDetail.hidden = false;
    drawFace(p);
    syncMapDetail();
    renderFaces();
    emit();
  }

  function relayout(p, keepCount = false) {
    const m = metaOf(p.id);
    if (!p.polygon || !p.gutterEdge) return;
    const out = layoutPanels(p.polygon, p.gutterEdge, p.tilt, panel);
    m.layoutMax = out.count;
    m.rects = out.rects;
    m.footprintM2 = out.areaM2;
    if (m.countAuto) p.maxPanels = out.count;
    else if (!keepCount) p.maxPanels = Math.min(p.maxPanels, out.count);
    drawFace(p);
  }

  function drawFace(p) {
    if (!map || !p.polygon) return;
    const old = layers.get(p.id);
    if (old) { old.all.forEach((l) => map.removeLayer(l)); }
    const col = faceColor(p);
    const all = [];
    const poly = L.polygon(p.polygon, { color: col, weight: 2, opacity: 0.95, fillColor: col, fillOpacity: 0.16 }).addTo(map);
    poly.on('click', (e) => { L.DomEvent.stop(e); if (mapState === 'draw') return; selectPlane(p.id); });
    all.push(poly);

    const m = metaOf(p.id);
    const rects = (m.rects || []).slice(0, p.maxPanels);
    for (const r of rects) {
      all.push(L.polygon(r, { color: '#ffffff', weight: 0.7, opacity: 0.8, fillColor: col, fillOpacity: 0.8, interactive: false }).addTo(map));
    }

    const c = polygonCentroid(p.polygon);
    all.push(L.marker(c, {
      icon: L.divIcon({ className: '', html: `<div class="rb-map-label"><span class="rb-face-tag">${faceTag(p)} · ${esc(p.name)}</span></div>`, iconSize: [0, 0] }),
      interactive: false, keyboard: false,
    }).addTo(map));

    if (p.gutterEdge) {
      const f = localFrame(p.polygon);
      const xy = p.polygon.map(f.toXY);
      let span = 0;
      for (const q of xy) span = Math.max(span, Math.hypot(q[0], q[1]));
      const len = Math.max(4, span * 0.75);
      const a = p.azimuth * D2R;
      const cx = f.toXY(c);
      const tipXY = [cx[0] + Math.sin(a) * len, cx[1] + Math.cos(a) * len];
      const tipLL = f.toLatLng(tipXY);
      const head = Math.max(1.2, len * 0.22);
      const hx = Math.sin(a), hy = Math.cos(a);          // downhill unit vector, in the local metre frame
      const baseXY = [tipXY[0] - hx * head, tipXY[1] - hy * head];
      all.push(L.polyline([c, f.toLatLng(baseXY)], { color: '#ffffff', weight: 3, opacity: 0.95, interactive: false }).addTo(map));
      all.push(L.polygon([
        tipLL,
        f.toLatLng([baseXY[0] + hy * head * 0.5, baseXY[1] - hx * head * 0.5]),
        f.toLatLng([baseXY[0] - hy * head * 0.5, baseXY[1] + hx * head * 0.5]),
      ], { color: '#ffffff', weight: 1, opacity: 0.95, fillColor: '#ffffff', fillOpacity: 0.95, interactive: false }).addTo(map));
      all.push(L.marker(f.toLatLng([tipXY[0] + hx * head, tipXY[1] + hy * head]), {
        icon: L.divIcon({ className: '', html: `<div class="rb-map-label"><span class="rb-down-tag">downhill ${esc(compassShort(p.azimuth))}</span></div>`, iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }).addTo(map));
      // Draggable corners, once the face is committed.
      p.polygon.forEach((pt, i) => {
        const mk = L.marker(pt, {
          draggable: true, icon: L.divIcon({ className: '', html: '<div class="rb-vertex"></div>', iconSize: [0, 0] }),
          keyboard: false, zIndexOffset: 700,
        }).addTo(map);
        mk.on('drag', (e) => { p.polygon[i] = [e.latlng.lat, e.latlng.lng]; poly.setLatLngs(p.polygon); });
        mk.on('dragend', () => {
          p.azimuth = round1(azimuthFromGutter(p.polygon, p.gutterEdge));
          if (!metaOf(p.id).renamed) p.name = defaultName(p.azimuth, p.id);
          relayout(p); syncMapDetail(); renderFaces(); emit();
        });
        all.push(mk);
      });
    }
    layers.set(p.id, { all });
  }

  function removeFaceLayers(id) {
    const l = layers.get(id);
    if (l && map) l.all.forEach((x) => map.removeLayer(x));
    layers.delete(id);
  }

  function syncMapDetail() {
    const p = selected();
    if (!p || !p.polygon || !p.gutterEdge) { mapDetail.hidden = true; mapMeasure.replaceChildren(); return; }
    mapDetail.hidden = st.path !== 'map';
    const m = metaOf(p.id);
    mapPitch.set(p.tilt);
    mapShade.set(p.shading.annual);
    if (document.activeElement !== mapName) mapName.value = p.name;
    if (document.activeElement !== mapCost) mapCost.value = p.costAdder || 0;
    mapFacing.textContent = `${p.name} points ${compassName(p.azimuth)} (${Math.round(p.azimuth)}°), downhill from its gutter.`;
    const fp = m.footprintM2 ?? polygonAreaM2(p.polygon);
    const slope = planeAreaFromFootprint(fp, p.tilt);
    mapMeasure.replaceChildren(
      h('span', {}, 'Footprint ', h('b', { text: `${fmt(m2ToFt2(fp))} ft²` }), ` (${fmt(fp)} m²)`),
      h('span', {}, 'Roof surface ', h('b', { text: `${fmt(m2ToFt2(slope))} ft²` }), ` (${fmt(slope)} m²)`),
      h('span', {}, 'Faces ', h('b', { text: `${compassShort(p.azimuth)} ${Math.round(p.azimuth)}°` })));
    mapCount.set(p.maxPanels, m.layoutMax ?? p.maxPanels,
      `${fmt(m.layoutMax ?? 0)} portrait modules fit at ${panel.w} W each. Drop the number to leave room for vents.`);
  }

  /* =============================================== path 3 — installer quote */

  const quoteBody = h('tbody');
  const quoteKwh = h('input', { type: 'number', min: '0', step: '100', id: uid('kwh'), oninput: () => {
    const v = parseFloat(quoteKwh.value);
    st.installerAnnualKwh = Number.isFinite(v) && v > 0 ? v : null;
    onCalibration({ installerAnnualKwh: st.installerAnnualKwh });
  } });

  editorQuote.append(
    h('div', { class: 'rb-step' },
      h('div', { class: 'rb-step-head' }, h('h2', { text: 'Copy the numbers off the proposal' }),
        h('p', { class: 'rb-hint', text: 'Most proposals break the system down by roof section, with a compass direction, a pitch and a module count for each. One row per section.' })),
      h('div', { class: 'rb-table-scroll' },
        h('table', { class: 'rb-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Section' }), h('th', { text: 'Direction' }), h('th', { text: 'Pitch' }),
            h('th', { text: 'Panels' }), h('th', { class: 'x' }))),
          quoteBody)),
      h('div', { class: 'rb-btn-row', style: { marginTop: '12px' } },
        h('button', { type: 'button', class: 'rb-btn', text: 'Add a section', onclick: addQuoteRow })),
      h('div', { class: 'rb-calib' },
        h('div', { class: 'rb-field rb-field-md' },
          h('label', { for: quoteKwh.id, text: "Installer's estimated annual kWh" }), quoteKwh),
        h('p', { class: 'rb-fine', style: { flex: '1 1 260px' } , text: 'Optional. We run our own model on the same roof and show you the gap on the Assumptions tab, so you can see whether the proposal is optimistic.' }))));

  function addQuoteRow() {
    const p = adoptPlane({ name: `Section ${st.planes.length + 1}`, tilt: 26.6, azimuth: 180, maxPanels: 10 });
    Object.assign(metaOf(p.id), { countAuto: false, renamed: true, hasSize: false });
    st.planes.push(p);
    st.selectedId = p.id;
    renderQuote(); renderFaces(); emit();
  }

  const DIRS = Array.from({ length: 16 }, (_, i) => i * 22.5);

  function renderQuote() {
    if (st.planes.length === 0) addQuoteRow();
    quoteBody.replaceChildren(...st.planes.map((p) => {
      const name = h('input', { type: 'text', value: p.name, 'aria-label': 'Section name', oninput: () => { metaOf(p.id).renamed = true; p.name = name.value; renderFaces(); emit(); } });
      // A traced face already has a direction, taken from the gutter edge it was
      // given on the map. Letting this select disagree with the polygon would put
      // out a Plane whose azimuth contradicts its own geometry, so it is locked
      // here and changed by re-tracing instead.
      const traced = !!(p.polygon && p.gutterEdge);
      const dirCell = traced
        ? h('div', { class: 'rb-fine' },
            h('b', { class: 'mono', text: `${compassShort(p.azimuth)} ${Math.round(p.azimuth)}°` }),
            ' — traced on the map')
        : null;
      const dir = h('select', { 'aria-label': 'Direction it faces' },
        ...DIRS.map((d) => h('option', { value: String(d), text: `${compassShort(d)} — ${cap(compassName(d))}` })));
      dir.value = String(DIRS.reduce((a, b) => (Math.abs(b - p.azimuth) < Math.abs(a - p.azimuth) ? b : a), 0));
      dir.addEventListener('input', () => {
        p.azimuth = parseFloat(dir.value);
        if (!metaOf(p.id).renamed) p.name = defaultName(p.azimuth, p.id);
        renderFaces(); emit();
      });
      const pitch = h('select', { 'aria-label': 'Roof pitch' },
        ...pitchOptions().map((o) => h('option', { value: String(o.deg), text: `${o.ratio} — ${o.label}` })));
      pitch.value = String(pitchOptions().reduce((a, b) => (Math.abs(b.deg - p.tilt) < Math.abs(a.deg - p.tilt) ? b : a)).deg);
      pitch.addEventListener('input', () => {
        p.tilt = parseFloat(pitch.value);
        if (traced) relayout(p);
        renderFaces(); emit();
      });
      const cnt = h('input', { type: 'number', min: '0', step: '1', value: p.maxPanels, 'aria-label': 'Panels on this section', oninput: () => {
        p.maxPanels = Math.max(0, parseInt(cnt.value, 10) || 0);
        const m = metaOf(p.id); m.countAuto = false;
        if (traced) { relayout(p, true); }
        renderFaces(); emit();
      } });
      return h('tr', {},
        h('td', {}, name), h('td', {}, dirCell || dir), h('td', {}, pitch), h('td', {}, cnt),
        h('td', { class: 'x' }, h('button', { type: 'button', class: 'rb-icon-btn', 'aria-label': `Remove ${p.name}`, onclick: () => removePlane(p.id) }, iconTrash())));
    }));
    if (document.activeElement !== quoteKwh) quoteKwh.value = st.installerAnnualKwh ?? '';
  }

  /* ================================================== the shared face list */

  let lastFaceIds = null;
  const faceRows = new Map();

  function faceFacts(p) {
    const kw = (p.maxPanels * panel.w) / 1000;
    const loss = p.shading.annual;
    const step = shadeStepFor(loss);
    const shade = Math.abs(step.loss - loss) < 0.005
      ? (step.key === 'none' ? 'no shade' : `${step.label.toLowerCase()} shade`)
      : `${Math.round(loss * 100)}% shade loss`;
    return [pitchRatioFor(p.tilt), `faces ${compassShort(p.azimuth)}`, `up to ${fmt(p.maxPanels)} panels`, `${fmt(kw, 1)} kW`, shade];
  }

  function renderFaces() {
    const ids = st.planes.map((p) => p.id).join('|');
    if (ids !== lastFaceIds) { rebuildFaces(); lastFaceIds = ids; }
    for (const p of st.planes) {
      const row = faceRows.get(p.id);
      if (!row) continue;
      row.root.setAttribute('data-sel', p.id === st.selectedId ? '1' : '0');
      row.stripe.style.background = `var(${FACE_VARS[st.planes.indexOf(p) % FACE_VARS.length]})`;
      if (document.activeElement !== row.name) row.name.value = p.name;
      row.name.setAttribute('aria-label', `Name of ${p.name}`);
      const facts = faceFacts(p);
      row.facts.replaceChildren(
        document.createTextNode(`${facts[0]} · ${facts[1]} · ${facts[2]} · `),
        h('span', { class: 'kw', text: facts[3] }),
        document.createTextNode(` · ${facts[4]}`));
    }
    renderTotals();
  }

  function rebuildFaces() {
    faceRows.clear();
    const head = h('div', { class: 'rb-faces-head' },
      h('h2', { text: 'Your roof' }),
      h('span', { class: 'rb-fine', text: st.planes.length === 1 ? '1 face' : `${st.planes.length} faces` }));
    const list = h('div', { class: 'rb-face-list' });

    if (st.planes.length === 0) {
      list.append(h('div', { class: 'rb-empty' },
        h('b', { text: 'No roof faces yet' }),
        'Pick a way in above. A gable roof has two faces; a hip roof has four. Start with the biggest one that gets sun.'));
    }

    for (const p of st.planes) {
      const stripe = h('div', { class: 'rb-face-stripe' });
      const name = h('input', {
        class: 'rb-face-name', type: 'text', value: p.name,
        onfocus: () => selectPlane(p.id),
        oninput: () => { metaOf(p.id).renamed = true; p.name = name.value; renderFaces(); emit(); },
      });
      const facts = h('div', { class: 'rb-face-facts' });
      const row = h('div', { class: 'rb-face', 'data-sel': '0', onclick: (e) => { if (e.target === name) return; selectPlane(p.id); } },
        stripe,
        h('div', { class: 'rb-face-body' }, name, facts),
        h('div', { class: 'rb-face-acts' },
          h('button', { type: 'button', class: 'rb-icon-btn', 'aria-label': `Edit ${p.name}`, onclick: () => editPlane(p.id) }, iconPencil()),
          h('button', { type: 'button', class: 'rb-icon-btn', 'aria-label': `Remove ${p.name}`, onclick: () => removePlane(p.id) }, iconTrash())));
      faceRows.set(p.id, { root: row, name, facts, stripe });
      list.append(row);
    }
    facesRail.replaceChildren(head, list, totalsBox);
  }

  const totalsBox = h('div', { class: 'rb-total' });

  function renderTotals() {
    const panels = st.planes.reduce((a, p) => a + p.maxPanels, 0);
    const kw = (panels * panel.w) / 1000;
    // Only count roof we actually have a measurement for: a traced polygon, or a
    // size the user gave. A proposal row is a panel count with no roof behind it.
    let fp = 0, known = 0, guessed = false;
    for (const p of st.planes) {
      if (p.polygon) { fp += polygonAreaM2(p.polygon); known++; continue; }
      if (!metaOf(p.id).hasSize) { guessed = true; continue; }
      const a = footprintOf(p);
      if (a > 0) { fp += a; known++; }
    }
    totalsBox.replaceChildren(
      tile('Faces', fmt(st.planes.length)),
      tile('Panels', fmt(panels)),
      tile('System size', `${fmt(kw, 1)} kW`),
      tile('Roof area', known ? `${fmt(m2ToFt2(fp))} ft²${guessed ? '+' : ''}` : '—'));
  }
  function tile(k, v) { return h('div', {}, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })); }

  function selectPlane(id) {
    if (st.selectedId === id) return;
    st.selectedId = id;
    if (st.path === 'simple') syncSimple();
    if (st.path === 'map') syncMapDetail();
    renderFaces();
  }

  function editPlane(id) {
    st.selectedId = id;
    const p = selected();
    if (p && p.polygon) { setPath('map'); mapState = p.gutterEdge ? 'edit' : 'gutter'; syncMapDetail(); if (map && p.polygon.length) map.fitBounds(L.latLngBounds(p.polygon).pad(0.6)); }
    else setPath('simple');
    renderFaces();
  }

  function removePlane(id) {
    const i = st.planes.findIndex((p) => p.id === id);
    if (i < 0) return;
    removeFaceLayers(id);
    st.planes.splice(i, 1);
    meta.delete(id);
    if (st.selectedId === id) st.selectedId = st.planes.length ? st.planes[Math.max(0, i - 1)].id : null;
    // Face colours are positional, so everything after the gap has to be redrawn.
    if (map) st.planes.forEach(drawFace);
    if (st.path === 'simple') { ensureStarterFace(); syncSimple(); }
    if (st.path === 'map') syncMapDetail();
    if (st.path === 'quote') renderQuote();
    renderFaces(); emit();
  }

  /* ------------------------------------------------------------- boot up */

  for (const p of st.planes) if (!p.polygon) metaOf(p.id).hasSize = false;
  renderSite();
  ensureStarterFace();
  setPath('simple');
  syncSimple();

  /* --------------------------------------------------------------- API */

  return {
    destroy() {
      cleanups.forEach((fn) => { try { fn(); } catch { /* already gone */ } });
      cleanups.length = 0;
      if (map) { map.remove(); map = null; }
      layers.clear();
      el.replaceChildren();
    },
    setPlanes(planes) {
      st.planes.forEach((p) => removeFaceLayers(p.id));
      meta.clear();
      st.planes = (planes || []).map(adoptPlane);
      // A plane handed back by the parent carries a panel count, not a measured
      // face, unless it also carries a polygon. Do not credit it with an area.
      for (const p of st.planes) if (!p.polygon) metaOf(p.id).hasSize = false;
      st.selectedId = st.planes.length ? st.planes[0].id : null;
      lastFaceIds = null;
      if (map) st.planes.filter((p) => p.polygon).forEach(drawFace);
      if (st.path === 'simple') { ensureStarterFace(); syncSimple(); }
      if (st.path === 'map') syncMapDetail();
      if (st.path === 'quote') renderQuote();
      renderFaces();
    },
    setSite(site) {
      if (!validSite(site)) return;
      st.site = { lat: +site.lat, lon: +site.lon };
      st.editingSite = false;
      renderSite();
      if (map) map.setView([st.site.lat, st.site.lon], map.getZoom() < 18 ? 20 : map.getZoom());
      else if (st.path === 'map') openMap();
      if (st.path === 'simple') syncSimple();
    },
    setPath,
  };

  /* --------------------------------------------------------- the dial */

  function makeDial(onAz, latOf) {
    const cx = 112, cy = 112;
    const svg = sv('svg', {
      class: 'rb-dial', viewBox: '0 0 224 224', role: 'slider', tabindex: '0',
      'aria-label': 'Direction the roof face points',
      'aria-valuemin': '0', 'aria-valuemax': '359', 'aria-valuenow': '180',
    });
    const sunBand = sv('path', { class: 'rb-dial-sun' });
    const sunDot = sv('g', { class: 'rb-dial-sunline' });
    svg.append(sv('circle', { class: 'rb-dial-ring', cx, cy, r: 82 }), sunBand, sunDot);

    for (let a = 0; a < 360; a += 11.25) {
      const major = Math.abs(a % 45) < 0.01;
      const r0 = major ? 72 : 77;
      svg.append(sv('line', {
        class: `rb-dial-tick${major ? ' major' : ''}`,
        x1: cx + Math.sin(a * D2R) * r0, y1: cy - Math.cos(a * D2R) * r0,
        x2: cx + Math.sin(a * D2R) * 82, y2: cy - Math.cos(a * D2R) * 82,
      }));
    }
    for (const [a, t] of [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']]) {
      svg.append(sv('text', {
        class: `rb-dial-lbl${a % 90 === 0 ? ' card' : ''}`,
        x: cx + Math.sin(a * D2R) * 62, y: cy - Math.cos(a * D2R) * 62, text: t,
      }));
    }
    const wedge = sv('path', { class: 'rb-dial-wedge' });
    const ridge = sv('line', { class: 'rb-dial-ridge' });
    const gutter = sv('line', { class: 'rb-dial-gutter' });
    const grip = sv('circle', { class: 'rb-dial-grip', r: 6.5 });
    svg.append(wedge, ridge, gutter, grip);

    const faceTxt = h('div', { class: 'rb-dial-face' });
    const degTxt = h('div', { class: 'rb-dial-deg' });
    const verdict = h('span', { class: 'rb-dial-verdict' }, h('i', { class: 'dot' }), h('span', {}));
    const nudge = h('input', { type: 'number', min: '0', max: '359', step: '1', id: uid('az'), oninput: () => { const v = parseFloat(nudge.value); if (Number.isFinite(v)) onAz(norm360(v)); } });
    const readout = h('div', { class: 'rb-dial-read' }, faceTxt, degTxt, verdict,
      h('div', { class: 'rb-dial-nudge' }, h('label', { for: nudge.id, text: 'Exact degrees' }), nudge));

    let cur = 180;
    function pointerAz(e) {
      const r = svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 6) return cur;
      return norm360(Math.atan2(dx, -dy) / D2R);
    }
    function snap(a, fine) { return fine ? Math.round(a) : Math.round(a / 5) * 5 % 360; }

    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      svg.focus();
      onAz(snap(pointerAz(e), e.shiftKey));
    });
    svg.addEventListener('pointermove', (e) => {
      if (!svg.hasPointerCapture?.(e.pointerId)) return;
      onAz(snap(pointerAz(e), e.shiftKey));
    });
    svg.addEventListener('pointerup', (e) => { try { svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } });
    svg.addEventListener('keydown', (e) => {
      const fine = e.shiftKey ? 1 : 5;
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + fine;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - fine;
      else if (e.key === 'PageUp') next = cur + 45;
      else if (e.key === 'PageDown') next = cur - 45;
      else if (e.key === 'Home') next = latOf() >= 0 ? 180 : 0;
      else if (e.key === 'End') next = latOf() >= 0 ? 0 : 180;
      if (next == null) return;
      e.preventDefault();
      onAz(norm360(next));
    });

    function set(az) {
      cur = norm360(az);
      const a = cur * D2R;
      const ux = Math.sin(a), uy = -Math.cos(a);
      const px = -uy, py = ux;
      const P = (r, q) => `${cx + ux * r + px * q},${cy + uy * r + py * q}`;
      wedge.setAttribute('d', `M${P(-22, -24)} L${P(-22, 24)} L${P(48, 31)} L${P(48, -31)} Z`);
      ridge.setAttribute('x1', cx + ux * -22 + px * -24); ridge.setAttribute('y1', cy + uy * -22 + py * -24);
      ridge.setAttribute('x2', cx + ux * -22 + px * 24); ridge.setAttribute('y2', cy + uy * -22 + py * 24);
      gutter.setAttribute('x1', cx + ux * 46 + px * -29); gutter.setAttribute('y1', cy + uy * 46 + py * -29);
      gutter.setAttribute('x2', cx + ux * 46 + px * 29); gutter.setAttribute('y2', cy + uy * 46 + py * 29);
      grip.setAttribute('cx', cx + ux * 62); grip.setAttribute('cy', cy + uy * 62);

      const north = latOf() >= 0;
      sunBand.setAttribute('d', annulus(cx, cy, 85, 94, north ? 62 : 242, north ? 298 : 118));
      const noon = north ? 180 : 0;
      const sx = cx + Math.sin(noon * D2R) * 89.5, sy = cy - Math.cos(noon * D2R) * 89.5;
      sunDot.replaceChildren(sv('circle', { cx: sx, cy: sy, r: 3.6, fill: 'currentColor', stroke: 'none' }),
        ...[0, 45, 90, 135].map((k) => sv('line', {
          x1: sx + Math.cos(k * D2R) * 5.6, y1: sy + Math.sin(k * D2R) * 5.6,
          x2: sx - Math.cos(k * D2R) * 5.6, y2: sy - Math.sin(k * D2R) * 5.6,
          'stroke-dasharray': 'none',
        })));

      const word = compassName(cur);
      faceTxt.textContent = `Faces ${word}`;
      degTxt.textContent = `${Math.round(cur)}° · ${compassShort(cur)}`;
      svg.setAttribute('aria-valuenow', String(Math.round(cur)));
      svg.setAttribute('aria-valuetext', `${word}, ${Math.round(cur)} degrees`);
      if (document.activeElement !== nudge) nudge.value = Math.round(cur);

      const off = Math.abs(((cur - (north ? 180 : 0) + 540) % 360) - 180);
      const cls = off <= 45 ? 'rb-v-best' : off <= 90 ? 'rb-v-ok' : 'rb-v-poor';
      verdict.className = `rb-dial-verdict ${cls}`;
      verdict.lastChild.textContent = off <= 45 ? 'Prime solar direction'
        : off <= 90 ? 'Workable — a little less sun' : 'Faces away from the sun';
    }
    set(180);
    return { node: svg, readout, set };
  }
}

/* ------------------------------------------------------------- SVG bits */

function annulus(cx, cy, r0, r1, a1, a2) {
  const p = (r, a) => [cx + Math.sin(a * D2R) * r, cy - Math.cos(a * D2R) * r];
  const large = ((a2 - a1 + 360) % 360) > 180 ? 1 : 0;
  const [x1, y1] = p(r1, a1), [x2, y2] = p(r1, a2), [x3, y3] = p(r0, a2), [x4, y4] = p(r0, a1);
  return `M${x1},${y1} A${r1},${r1} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${large} 0 ${x4},${y4} Z`;
}

/** A gable seen end-on, drawn at the actual pitch. */
function gableIcon(deg) {
  const rise = Math.min(20, 20 * Math.tan(deg * D2R));
  const apex = 26 - rise;
  return sv('svg', { viewBox: '0 0 56 34', 'aria-hidden': 'true' },
    sv('line', { class: 'rb-gable-wall', x1: 4, y1: 31.5, x2: 52, y2: 31.5 }),
    sv('line', { class: 'rb-gable-wall', x1: 9, y1: 26, x2: 9, y2: 31.5 }),
    sv('line', { class: 'rb-gable-wall', x1: 47, y1: 26, x2: 47, y2: 31.5 }),
    sv('polyline', { class: 'rb-gable-roof', points: `8,26 28,${apex.toFixed(2)} 48,26` }));
}

function iconGable() {
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    sv('path', { d: 'M3 12 12 5l9 7' }), sv('path', { d: 'M5.5 11v8h13v-8' }), sv('path', { d: 'M10 19v-5h4v5' }));
}
function iconTrace() {
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    sv('path', { d: 'M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z', 'stroke-dasharray': '3 2.4' }),
    sv('circle', { cx: 4, cy: 8.5, r: 1.9, fill: 'currentColor', stroke: 'none' }),
    sv('circle', { cx: 20, cy: 15.5, r: 1.9, fill: 'currentColor', stroke: 'none' }));
}
function iconDoc() {
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    sv('path', { d: 'M6 3h8l4 4v14H6z' }), sv('path', { d: 'M14 3v4h4' }),
    sv('path', { d: 'M9 12h6M9 15.5h6M9 19h3' }));
}
function iconPencil() {
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    sv('path', { d: 'M4 20h4L19 9l-4-4L4 16z' }), sv('path', { d: 'M14.5 5.5 18.5 9.5' }));
}
function iconTrash() {
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    sv('path', { d: 'M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20h9l1-13.5' }));
}

/* --------------------------------------------------------------- helpers */

let uidSeq = 0;
function uid(prefix) { return `rb-${prefix}-${++uidSeq}`; }

/** Left/right/up/down moves focus and selection inside a radio group. */
function rovingKeys(e, btns, pick) {
  const i = btns.indexOf(e.currentTarget);
  let j = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % btns.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + btns.length) % btns.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = btns.length - 1;
  if (j == null) return;
  e.preventDefault();
  pick(j);
  btns[j].focus();
}

export default { mountRoofBuilder };
