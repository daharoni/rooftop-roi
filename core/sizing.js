/* =============================================================================
 * core/sizing.js - utility interconnection sizing rules.
 *
 * SCE's Solar Billing Plan accepts a system "oversized" up to 150% of the
 * customer's previous 12 months of usage (an affidavit above 100%; refused
 * above 150%).  SCE does not model the roof: it takes the CEC-AC nameplate
 * and assumes a flat 20% capacity factor,
 *
 *     estimated kWh/yr = CEC-AC kW x 720 x 0.20 x 12  =  CEC-AC kW x 1,728
 *
 * and compares that with the last 12 months of metered kWh.  CEC-AC per panel
 * is the PTC rating times the inverter's CEC weighted efficiency, roughly 0.90
 * of STC nameplate for a modern module on a microinverter; `acFactor` is that
 * ratio, exposed as a knob because the exact figure depends on the quote.
 *
 * Source: SCE Solar Billing Plan FAQ and SCE's Supplemental Webinar FAQ.
 * Pure arithmetic, no I/O; shared by the dashboard and the copied summary.
 * ========================================================================== */

export const SCE_KWH_PER_AC_KW = 720 * 0.20 * 12;      // 1,728

/**
 * Panel counts at SCE's 100% and 150% lines for a given 12-month usage.
 * Returns null when there is nothing to size against.
 */
export function sceCap({ annualKwh, panelW, acFactor = 0.9 }) {
  if (!(annualKwh > 0) || !(panelW > 0) || !(acFactor > 0)) return null;
  const kwhPerPanel = (panelW / 1000) * acFactor * SCE_KWH_PER_AC_KW;
  const at = (ratio) => Math.floor(ratio * annualKwh / kwhPerPanel + 1e-9);
  return {
    annualKwh, kwhPerPanel,
    panelsAt100: at(1.0),
    panelsAt150: at(1.5),
    estimatedKwh: (panels) => panels * kwhPerPanel,
  };
}

/**
 * Metered kWh over the most recent 12 months of a LoadSet (ts are local
 * "YYYY-MM-DDTHH:00" strings).  A record shorter than a year is scaled up to
 * one; shorter than 30 days returns null rather than guess.
 */
export function recentAnnualKwh(loadSet, days = 365) {
  if (!loadSet || !loadSet.ts || !loadSet.ts.length) return null;
  const ts = loadSet.ts, kwh = loadSet.kwh;
  const last = Date.parse(ts[ts.length - 1]), first = Date.parse(ts[0]);
  if (!isFinite(last) || !isFinite(first)) return null;
  const spanDays = (last - first) / 86400000 + 1 / 24;
  if (spanDays < 30) return null;
  const from = last - days * 86400000;
  let sum = 0;
  for (let i = ts.length - 1; i >= 0; i--) {
    const t = Date.parse(ts[i]);
    if (t <= from) break;
    const v = kwh[i];
    if (isFinite(v)) sum += v;
  }
  return spanDays < days ? sum * (days / spanDays) : sum;
}

const SolarSizing = { SCE_KWH_PER_AC_KW, sceCap, recentAnnualKwh };
export default SolarSizing;
