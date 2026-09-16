/* =============================================================================
 * summary.js — the plain-text scenario summary behind "Copy summary".
 *
 * Written to be pasted into an email to an installer or a spouse: no markup, no
 * jargon without its unit, and the URL at the bottom reproduces the exact
 * scenario, because the whole of the state is in the hash.
 * ========================================================================== */

import { fmtMoney, fmtNum, fmtPct, fmtYears } from "./format.js";

export function summaryText(state, ctx) {
  const cell = ctx.selected;
  if (!cell) return "Rooftop ROI — no simulation has run yet.";
  const f = cell.finance || {};
  const meta = (ctx.loadSet && ctx.loadSet.meta) || {};
  const L = [];

  L.push("ROOFTOP ROI — SOLAR + STORAGE SCENARIO");
  if (meta.start) L.push(`Built from ${fmtNum(meta.nHours, 0)} hours of your own meter data (${meta.start} to ${meta.end})`);
  L.push("");

  L.push(`SYSTEM   ${cell.panels} panels @ ${state.system.panelW} W = ${fmtNum(cell.kwdc, 2)} kW DC, `
    + `${cell.batteries} × ${state.system.battKWh} kWh = ${fmtNum(cell.battKWhTotal, 0)} kWh usable storage`);
  for (const plane of state.roof.planes) {
    const n = planePanels(cell, plane.id);
    if (n) L.push(`         ${n} on ${plane.name} — ${plane.tilt}° tilt, ${plane.azimuth}° azimuth`);
  }
  L.push(`         strategy ${state.system.strategy}, ${fmtPct(state.system.minReserve, 0)} backup reserve`
    + (state.system.ngom ? ", net generation output meter fitted" : ""));
  L.push(`         weather ${state.ui.weatherKey}${ctx.annualPerKw ? ` (${fmtNum(ctx.annualPerKw, 0)} kWh/kW-yr)` : ""}`);
  L.push(`PLAN     ${ctx.planLabel || state.tariff.planId}`);

  if (state.flex.length) {
    for (const flx of state.flex) {
      const s = flx.schedule || {};
      L.push(`LOAD     ${flx.name}: ${fmtNum(flx.annualKwh * (flx.scale ?? 1), 0)} kWh/yr, `
        + (s.mode === "spread"
          ? `spread over ${s.daysPerWeek} days/week, ${fmtPct(s.daylightFraction, 0)} inside `
            + `${String(s.window?.[0]).padStart(2, "0")}:00–${String(s.window?.[1]).padStart(2, "0")}:00`
          : "left as recorded"));
    }
  }
  if (state.baseLoadScale !== 1) L.push(`         rest of the house scaled to ${fmtPct(state.baseLoadScale, 0)} of today`);
  L.push("");

  const mode = state.fin.financing.mode;
  L.push(`PRICE    $${state.fin.costPerW.toFixed(2)}/W solar, $${state.fin.costPerKwh}/kWh storage`
    + (f.effectiveDiscount > 0 ? `, ${fmtPct(f.effectiveDiscount, 1)} incentive discount` : ""));
  L.push(`         gross ${fmtMoney(f.gross)}  →  net ${fmtMoney(f.netCost)}`);
  if (mode === "cash") L.push(`PAID     cash, ${fmtMoney(f.netCost)} up front`);
  if (mode === "loan") {
    L.push(`PAID     loan: ${fmtMoney(f.downPayment)} down, ${fmtMoney(f.monthlyPayment)}/mo for `
      + `${state.fin.financing.loan.termYears} yr at ${fmtPct(state.fin.financing.loan.apr, 2)} APR `
      + `(${fmtMoney(f.totalInterest)} total interest)`);
  }
  if (mode === "lease") {
    L.push(`PAID     lease: ${fmtMoney(state.fin.financing.lease.monthly)}/mo rising `
      + `${fmtPct(state.fin.financing.lease.escalatorPct, 1)}/yr for ${state.fin.financing.lease.termYears} yr`);
  }
  L.push(`FINANCE  ${state.fin.horizon} yr horizon, ${fmtPct(state.fin.escalation, 1)} rate escalation, `
    + `${fmtPct(state.fin.investReturn, 1)} investment return, ${fmtPct(state.fin.discountRate, 1)} inflation`);
  L.push("");

  L.push(`RESULT   bill ${fmtMoney(ctx.baselineBill)}/yr  →  ${fmtMoney(cell.bill)}/yr   (saves ${fmtMoney(cell.savings)}/yr)`);
  L.push(`         of which           ${fmtMoney(cell.importSavings)} avoided import (escalates) `
    + `+ ${fmtMoney(cell.exportRevenue)} export credit (locked)`);
  L.push(`         NPV vs investing   ${fmtMoney(cell.npv)}`);
  L.push(`         IRR                ${cell.irr === null || cell.irr === undefined ? "n/a" : fmtPct(cell.irr, 1)}`);
  L.push(`         payback            ${fmtYears(cell.payback)} (discounted ${fmtYears(cell.discountedPayback)})`);
  L.push(`         wealth at ${state.fin.horizon} yr   system ${fmtMoney(f.wealthSystem)}  vs  invested ${fmtMoney(f.wealthInvest)}`);
  L.push(`         monthly outlay     ${fmtMoney(f.firstYearMonthlyOutlay)}/mo in year 1 `
    + `vs ${fmtMoney(f.currentMonthlyBill)}/mo today`);
  L.push(`         LCOE               ${fmtMoney(cell.lcoe, 3)}/kWh`);
  L.push(`         production         ${fmtNum(cell.pvKwh, 0)} kWh/yr, ${fmtPct(cell.selfSufficiency, 0)} self-sufficient, `
    + `${fmtNum(cell.exportKwh, 0)} kWh exported, ${fmtNum(cell.cycles, 0)} cycles/yr`);
  L.push("");
  L.push("Not financial advice and not a quote. Rates change; check the Assumptions tab for effective dates.");
  if (typeof location !== "undefined") L.push(`Reproduce this exact scenario: ${location.href}`);
  return L.join("\n");
}

function planePanels(cell, planeId) {
  if (!cell.panelsByPlane) return 0;
  if (Array.isArray(cell.panelsByPlane)) {
    const i = (cell.planeIds || []).indexOf(planeId);
    return i < 0 ? 0 : cell.panelsByPlane[i];
  }
  return cell.panelsByPlane[planeId] || 0;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export default { summaryText, copyToClipboard };
