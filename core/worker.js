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
               exportRevenue: r.exportRevenue, bill: r.bill,
               baselineBill: r.baselineSameFlex.bill };
    };
    return { label: "Flexible load kWh/yr", low: mk(0.8), high: mk(1.2) };
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
      var grid = O.searchGrid(ctx, hydrate(m.params), {
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
                 exportRevenue: s.exportRevenue, baselineBill: s.baselineSameFlex.bill };
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
      post({ type: "error", id: m.id, message: (err && err.message) || String(err),
             stack: err && err.stack });
    }
  };
})(typeof self !== "undefined" ? self : this);
