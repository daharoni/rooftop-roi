/* =============================================================================
 * presets.js — battery products, so a person can pick "Powerwall 3" instead of
 * knowing its kWh, kW and round-trip efficiency.
 *
 * Figures are spec-sheet values, approximate: they fill the three battery
 * sliders and nothing else.  Moving a slider by hand turns the pick back to
 * "custom" (main.js does both).  No imports, so state.js can read the ids.
 * ========================================================================== */

export const BATTERY_PRESETS = [
  { id: "custom",   name: "Custom",                     kwh: null, kw: null, rte: null },
  { id: "pw3",      name: "Tesla Powerwall 3",          kwh: 13.5, kw: 11.5, rte: 0.89 },
  { id: "pw3x",     name: "Powerwall 3 + expansion",    kwh: 27,   kw: 11.5, rte: 0.89 },
  { id: "iq5p",     name: "Enphase IQ Battery 5P",      kwh: 5.0,  kw: 3.84, rte: 0.90 },
  { id: "iq10c",    name: "Enphase IQ Battery 10C",     kwh: 10.0, kw: 7.08, rte: 0.90 },
  { id: "franklin", name: "FranklinWH aPower 2",        kwh: 15.0, kw: 10.0, rte: 0.89 },
];

/** A new system object with the preset's kWh, kW and RTE copied in; "custom" or an unknown id leaves it unchanged. */
export function applyPreset(system, id) {
  const p = BATTERY_PRESETS.find((x) => x.id === id);
  const out = { ...system, battPreset: p ? p.id : (system && system.battPreset) || "custom" };
  if (!p || p.kwh === null) return out;
  out.battKWh = p.kwh; out.battKW = p.kw; out.rte = p.rte;
  return out;
}

/** Options for a select, "Custom" first. */
export function presetOptions() {
  return BATTERY_PRESETS.map((p) => ({ v: p.id, t: p.name }));
}

/** The preset whose kWh and kW match the system's (within 0.01), else "custom". */
export function matchPreset(system) {
  if (!system) return "custom";
  const hit = BATTERY_PRESETS.find((p) => p.kwh !== null
    && Math.abs(p.kwh - system.battKWh) <= 0.01 && Math.abs(p.kw - system.battKW) <= 0.01);
  return hit ? hit.id : "custom";
}

export default { BATTERY_PRESETS, applyPreset, presetOptions, matchPreset };
