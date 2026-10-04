/* =============================================================================
 * core/worker.js - the Blob-worker body.
 *
 * This file is NOT an ES module.  It is a classic script that expects the four core
 * namespaces to already exist in its scope:
 *
 *     SolarEngine   SolarFinance   SolarOptimizer   FlexLoad
 *
 * `node core/bundle-for-worker.mjs` concatenates core/flexload.js, core/engine.js,
 * core/finance.js, core/optimizer.js and this file into app/worker-bundle.js - the
 * one generated file in the repo, and it is committed.  The UI fetches that file as
 * text and starts it either as a Blob Worker or, where a CSP forbids Blob workers,
 * on the main thread behind a postMessage-shaped shim:
 *
 *     new Function("self", src)(shim)       // shim = { onmessage, postMessage }
 *
 * so nothing here may touch `window` or `document`, and `self` must be the only
 * global it writes to.
 *
 * -----------------------------------------------------------------------------
 * PROTOCOL
 * -----------------------------------------------------------------------------
 * in  { type:"init", load, tariffs, solar }        solar = { byPlane: { planeId: SolarProfiles } }
 * out { type:"ready", quality, hours, days, plans, providers, flexImpl }
 *
 * in  { type:"grid", id, params, maxPanelsTotal, maxBatteries, planeCaps, step }
 * out { type:"progress", id, done, total }   ... repeatedly
 * out { type:"grid", id, grid }
 *
 * in  { type:"detail", id, params, panelsByPlane, batteries, weatherKeys }
 * out { type:"detail", id, detail }
 *
 * in  { type:"validate", id, params, start, end }
 * out { type:"validate", id, result }
 *
 * out { type:"error", id, message, stack }        on any thrown exception
 *
 * `params.billing` ("nbt" | "nem2" | "nem1") and `params.existing` ({ planeId, panels } |
 * null) pass straight through to the engine.  With `existing` set, "grid" fixes the
 * panel axis at the existing array (every panel on the existing plane) and sweeps the
 * battery count only: the cells keep searchGrid's shape, with a one-entry panelList.
 *
 * `params.planes` may omit `profile`: the worker fills it from the cached SolarProfiles
 * for that plane at `params.weatherKey`, which is why init carries the solar bundle.
 * ========================================================================== */

(function (global) {
  "use strict";

  var E = SolarEngine, F = SolarFinance, O = SolarOptimizer;
  var ctx = null, solar = null;

  function post(msg) { global.postMessage(msg); }

  /** Give every plane a concrete 8760 profile for the requested weather year. */
  function hydrate(params) {
    var p = Object.assign({}, params || {});
    var key = p.weatherKey || "tmy";
    // Existing-solar mode: the regime and the existing array, normalised so a stale or
    // hand-edited message cannot smuggle a half-set object into the engine.
    p.billing = p.billing === "nem2" || p.billing === "nem1" ? p.billing : "nbt";
    var ex = p.existing;
    var exPanels = ex ? Math.max(0, Math.round(+ex.panels || 0)) : 0;
    p.existing = exPanels > 0 ? { planeId: ex.planeId == null ? null : String(ex.planeId), panels: exPanels } : null;
    p.planes = (p.planes || []).map(function (pl) {
      if (pl.profile) return pl;
      var sp = solar && solar.byPlane ? solar.byPlane[pl.id] : null;
      return Object.assign({}, pl, { profile: sp ? E.profileFor(sp, key) : null });
    });
    return p;
  }

  /** The period id per hour for the weekday schedule, for the UI's TOU strip. */
  function scheduleStrip(planId) {
    var plan = E.planById(ctx.tariffs, planId), out = {};
    ["summer", "winter"].forEach(function (s) {
      out[s] = plan.schedule[s].weekday.slice();
      out[s + "Weekend"] = plan.schedule[s].weekend.slice();
    });
    return out;
  }

  /** +-20% on every flexible load, for the tornado's simulation-side bar. */
  function flexVariants(params, panelsByPlane, batteries) {
    var base = params.flex || [];
    if (!base.length) return null;
    var mk = function (mult) {
      var q = hydrate(Object.assign({}, params, {
        panelsByPlane: panelsByPlane, batteries: batteries,
        flex: base.map(function (f) {
          return Object.assign({}, f, { scale: (f.scale == null ? 1 : f.scale) * mult });
        }),
      }));
      var r = E.simulate(ctx, q, {});
      return { savings: r.savingsVsSameFlex, importSavings: r.importSavingsVsSameFlex,
               exportRevenue: r.exportRevenue, accPlusRevenue: r.accPlusRevenue, bill: r.bill,
               baselineBill: r.baselineSameFlex.bill };
    };
    return { label: "Flexible load kWh/yr", low: mk(0.8), high: mk(1.2) };
  }

  var MAX_EXISTING_BATTERIES = 20;   // optimizer.MAX_SEARCH_BATTERIES

  /**
   * The grid for a household that already has solar: the panel count is not a choice
   * (adding panels would move the whole system to Net Billing), so the only axis is
   * the battery count.  Same return shape as SolarOptimizer.searchGrid.
   */
  function existingGrid(params, m) {
    var p = E.withDefaults(params);
    var b = E.baselines(ctx, p, false);
    var scn = b.scnSame, xs = scn.existing;
    var nP = scn.planes.length;
    var alloc = [];
    for (var k = 0; k < nP; k++) alloc.push(k === xs.planeIndex ? xs.panels : 0);
    var maxB = Math.floor(Number(m.maxBatteries));
    if (!isFinite(maxB) || maxB < 0) maxB = 6;
    if (maxB > MAX_EXISTING_BATTERIES) maxB = MAX_EXISTING_BATTERIES;
    var battList = [], cells = [];
    for (var nb = 0; nb <= maxB; nb++) battList.push(nb);
    for (var i = 0; i < battList.length; i++) {
      var res = E.runHours(scn, Object.assign({}, p, { panelsByPlane: alloc.slice(), batteries: battList[i] }), false);
      E.attachSavings(res, b.sameFlex.bill, b.asRecorded.bill);
      cells.push(res);
      post({ type: "progress", id: m.id, done: i + 1, total: battList.length });
    }
    var order = [];
    for (var n = 0; n < xs.panels; n++) order.push(xs.planeIndex);
    return {
      cells: cells, panelList: [xs.panels], battList: battList,
      planes: scn.planes.map(function (pl, k) { return { id: pl.id, name: pl.name, cap: k === xs.planeIndex ? xs.panels : 0 }; }),
      allocationOrder: order, greedyBatteries: 0,
      baselineSameFlex: b.sameFlex, baselineAsRecorded: b.asRecorded,
      flexShiftOnlySavings: b.asRecorded.bill - b.sameFlex.bill,
      weatherKey: scn.weatherKey,
      years: ctx.years !== undefined ? ctx.years : ctx.nDays / 365, hours: ctx.N,
      existing: { planeId: xs.planeId, planeFallback: xs.planeFallback, panels: xs.panels,
                  pvKwh: b.sameFlex.existingPvKwh, grossClippedKwh: xs.grossClippedKwh / ctx.years,
                  billing: p.billing },
    };
  }

  var HANDLERS = {
    init: function (m) {
      ctx = E.prepare({ load: m.load, tariffs: m.tariffs });
      solar = m.solar || null;
      post({ type: "ready", quality: ctx.quality, hours: ctx.N, days: ctx.nDays,
             years: ctx.years, flexImpl: E.flexReshapeSource(),
             plans: ctx.tariffs.plans.map(function (p) { return { id: p.id, name: p.name }; }),
             providers: Object.keys(ctx.tariffs.providers || {}).map(function (k) {
               return { id: k, name: (ctx.tariffs.providers[k] || {}).name || k };
             }) });
    },

    grid: function (m) {
      var hp = hydrate(m.params);
      if (hp.existing && (hp.planes || []).length) {
        post({ type: "grid", id: m.id, grid: existingGrid(hp, m) });
        return;
      }
      var grid = O.searchGrid(ctx, hp, {
        maxPanelsTotal: m.maxPanelsTotal, maxBatteries: m.maxBatteries,
        planeCaps: m.planeCaps, step: m.step, greedyBatteries: m.greedyBatteries,
        onProgress: function (done, total) { post({ type: "progress", id: m.id, done: done, total: total }); },
      });
      post({ type: "grid", id: m.id, grid: grid });
    },

    detail: function (m) {
      var params = hydrate(Object.assign({}, m.params, {
        panelsByPlane: m.panelsByPlane, batteries: m.batteries,
      }));
      var res = E.simulate(ctx, params, { detail: true });
      res.plans = E.billOnAllPlans(ctx, params);
      res.providers = E.billOnAllProviders(ctx, params);
      res.schedule = scheduleStrip(params.planId);
      res.flexVariants = flexVariants(m.params, m.panelsByPlane, m.batteries);
      // One run per weather year, so the UI can show the production spread.
      res.weather = (m.weatherKeys || []).map(function (w) {
        var q = hydrate(Object.assign({}, params, { weatherKey: w.key, planes: (m.params.planes || []) }));
        var s = E.simulate(ctx, q, {});
        return { key: w.key, label: w.label, group: w.group, pvKwh: s.pvKwh, bill: s.bill,
                 savings: s.savingsVsSameFlex, importSavings: s.importSavingsVsSameFlex,
                 exportRevenue: s.exportRevenue, accPlusRevenue: s.accPlusRevenue, baselineBill: s.baselineSameFlex.bill };
      });
      // The hourly arrays are only meaningful to the charts that ask for them.
      if (!m.wantHourly) delete res.hourly;
      post({ type: "detail", id: m.id, detail: res });
    },

    validate: function (m) {
      post({ type: "validate", id: m.id,
             result: E.billPeriod(ctx, m.params || {}, m.start, m.end) });
    },
  };

  global.onmessage = function (e) {
    var m = e.data || {};
    try {
      var h = HANDLERS[m.type];
      if (!h) throw new Error("unknown message type: " + m.type);
      if (m.type !== "init" && !ctx) throw new Error("worker received '" + m.type + "' before 'init'");
      h(m);
    } catch (err) {
      // `code`, `usableDays` and `phase` let the page tell "your file is too short"
      // (E.prepare throws INSUFFICIENT_DATA) apart from a bug.
      post({ type: "error", id: m.id, phase: m.type, message: (err && err.message) || String(err),
             userMessage: err && err.userMessage, code: err && err.code,
             usableDays: err && err.usableDays, stack: err && err.stack });
    }
  };
})(typeof self !== "undefined" ? self : this);
