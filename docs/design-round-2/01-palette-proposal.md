# Design round 2 — 01 · Palette, type and token proposal

Scope: `app/styles.css` tokens (base lines 16–88, override lines 636–667) and the type that rides on them.
All ratios below are WCAG 2.x, computed from the hex values given; OKLCH is approximate (L%, C, hue°).

## 1. Diagnosis

The page reads yellow-brown because all three paper tones share one warm hue at real chroma:
`--page #f5f2e9` = oklch(96.1% 0.012 92°), `--surface #fffdf7` = oklch(99.4% 0.008 91°),
`--sunken #eeeadf` = oklch(93.7% 0.015 90°). Hue 90° is yellow, and 0.012–0.015 is about four times
the chroma of the original neutral base (`#f9f9f7`, C 0.003). `#f5f2e9` is also within a hair of the
"warm cream" background that generated sites default to, so it works against the "not generic LLM"
goal. The inks then sit at hue 140–169° (`--ink-3 #626b60` is olive at 140°). Green-grey ink on yellow
paper mixes, to the eye, into khaki/brown. Dark mode carries the same cast: `--ink #f4f0e5` is
oklch(95.5% 0.015 90°). Georgia/Times adds a newsprint feel without being a deliberate choice, and
the orange `--s2` used decoratively (`.field-note` border, the hero solar area) pulls the landing
further toward orange.
**Keep:** the roofline mark (`.roof-mark`), the numbered pipeline (`counter(steps)`, a real sequence), the
editorial serif headline voice (`.lede`, section h2s, italic field-note heading), the 3px accent top rule
(`.hero-figure-wrap`, `.headline`) and the accent inset on `.tile.key`. These are what give the page
its own identity; the paper colour is the only thing that needs to go.

## 2a. Recommended — "Marine layer"

A California coast morning under the June fog: cool grey-white paper with a faint blue cast, slate
inks, and one dark spruce-green for anything you can act on. The identity comes from the mark, the
serif and the rules, not from tinted paper, so the instrument reads clean and modern while the
headlines still sound like a field guide.

| token | light | OKLCH | dark | OKLCH |
|---|---|---|---|---|
| --page | #f1f5f7 | 96.8% 0.005 229° | #0c1214 | 17.7% 0.010 220° |
| --surface | #fcfdfe | 99.4% 0.002 (≈neutral) | #151b1e | 21.7% 0.011 230° |
| --sunken | #e7edef | 94.2% 0.007 220° | #080c0e | 15.1% 0.008 229° |
| --ink | #162024 | 23.6% 0.016 224° | #f0f4f6 | 96.5% 0.005 229° |
| --ink-2 | #485358 | 43.4% 0.016 227° | #c1c9cc | 83.1% 0.010 222° |
| --ink-3 | #626c70 | 52.4% 0.014 224° | #97a0a4 | 70.0% 0.012 226° |
| --grid | #dce2e4 | 90.9% 0.007 220° | #262d2f | 29.1% 0.010 217° |
| --rule | #b0b9bc | 78.0% 0.011 220° | #464f52 | 42.1% 0.013 220° |
| --neutral-mid | #eaeaea | 93.7% 0.000 | #353535 | 32.9% 0.000 |
| --accent | #145a58 | 42.6% 0.066 192° | #7ad0c5 | 80.0% 0.085 185° |

Contrast, light: ink/surface 16.3; **ink-2/surface 7.77** (on page 7.21); **ink-3/surface 5.29**
(on page 4.91, on sunken 4.56); accent/surface 7.83, accent/page 7.27; on-accent (#fcfdfe) on accent 7.83.
Contrast, dark: ink/surface 15.7; **ink-2/surface 10.35**; **ink-3/surface 6.53**; dark text on accent 10.48.
`--neutral-mid` is the heat map's diverging midpoint. It is deliberately chroma 0, because a blue-cast
midpoint would read as a weak "good" value.

```css
:root {
  color-scheme: light;
  --page: #f1f5f7;  --surface: #fcfdfe;  --sunken: #e7edef;
  --ink: #162024;   --ink-2: #485358;    --ink-3: #626c70;
  --grid: #dce2e4;  --rule: #b0b9bc;
  --border: rgba(22, 32, 36, 0.12);
  --shadow: 0 1px 2px rgba(22, 32, 36, 0.06);
  --shadow-pop: 0 8px 24px rgba(22, 32, 36, 0.14);
  --neutral-mid: #eaeaea;

  --s1: #2a78d6;  --s2: #eb6834;  --s3: #1baf7a;  --s4: #eda100;
  --s5: #e87ba4;  --s6: #008300;  --s7: #4a3aa7;  --s8: #e34948;
  --good: #0ca30c;  --warning: #fab219;  --serious: #ec835a;  --critical: #d03b3b;
  --good-text: #006300;

  --accent: #145a58;  --on-accent: #fcfdfe;  --focus: #145a58;

  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --editorial: "Source Serif 4", "Source Serif Pro", Charter, "Iowan Old Style", Georgia, serif;
  --rail: 320px;  --r-sm: 3px;  --r-md: 6px;
}
/* one dark set, written once and applied by both selectors */
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* same block as below */ } }
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0c1214;  --surface: #151b1e;  --sunken: #080c0e;
  --ink: #f0f4f6;   --ink-2: #c1c9cc;    --ink-3: #97a0a4;
  --grid: #262d2f;  --rule: #464f52;
  --border: rgba(240, 244, 246, 0.10);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.5);
  --neutral-mid: #353535;
  --s1: #3987e5;  --s2: #d95926;  --s3: #199e70;  --s4: #c98500;
  --s5: #d55181;  --s6: #008300;  --s7: #9085e9;  --s8: #e66767;
  --critical: #ef7a72;            /* was inheriting #d03b3b: 3.62:1 on dark surface, fails as pill/error text */
  --good-text: #0ca30c;
  --accent: #7ad0c5;  --on-accent: #0c1214;  --focus: #7ad0c5;
}
```
(The media-query block must repeat the dark declarations verbatim, since CSS cannot share a block between the
two selectors without a preprocessor. That is the existing pattern; the point is that it appears **once** in the base,
not again in an override.)

## 2b. Alternative — "Chaparral & blueprint"

The paper takes the faint sage of coastal scrub, and actions are drawn in a survey-blueprint navy, so
green means only one thing on the page: the "good" verdict. It is a little more characterful than
Marine layer, but it gives up the forest-green action colour the owner already liked.

| token | light | OKLCH | dark | OKLCH |
|---|---|---|---|---|
| --page | #f2f5f3 | 96.7% 0.004 157° | #0d120e | 17.5% 0.011 151° |
| --surface | #fcfdfc | 99.3% 0.002 | #171c17 | 21.9% 0.012 145° |
| --sunken | #e9ede9 | 94.2% 0.007 146° | #090d0a | 15.3% 0.009 153° |
| --ink | #19201a | 23.4% 0.015 149° | #f1f4f2 | 96.4% 0.004 157° |
| --ink-2 | #4b544d | 43.6% 0.016 152° | #c3c9c4 | 83.0% 0.010 151° |
| --ink-3 | #656d66 | 52.6% 0.015 149° | #99a19a | 70.0% 0.014 149° |
| --grid | #dde2de | 90.8% 0.008 152° | #282d28 | 29.0% 0.011 145° |
| --rule | #b3b9b4 | 78.0% 0.010 151° | #484f49 | 41.9% 0.013 150° |
| --neutral-mid | #eaeaea | neutral | #353535 | neutral |
| --accent | #204b6d | 39.9% 0.075 245° | #8fb8e0 | 76.7% 0.073 248° |

Contrast: light ink-2/surface **7.70**, ink-3/surface **5.24** (page 4.86); accent/surface 9.00.
Dark ink-2/surface **10.27**, ink-3/surface **6.52**; accent on dark page 9.10.

```css
:root {
  --page: #f2f5f3; --surface: #fcfdfc; --sunken: #e9ede9;
  --ink: #19201a;  --ink-2: #4b544d;   --ink-3: #656d66;
  --grid: #dde2de; --rule: #b3b9b4;    --neutral-mid: #eaeaea;
  --border: rgba(25, 32, 26, 0.12);
  --accent: #204b6d; --on-accent: #fcfdfc; --focus: #204b6d; --good-text: #006300;
  /* --s1..--s8, status, fonts, radii: identical to Marine layer */
}
:root[data-theme="dark"] {   /* + the same block under the prefers-color-scheme query */
  --page: #0d120e; --surface: #171c17; --sunken: #090d0a;
  --ink: #f1f4f2;  --ink-2: #c3c9c4;   --ink-3: #99a19a;
  --grid: #282d28; --rule: #484f49;    --neutral-mid: #353535;
  --border: rgba(241, 244, 242, 0.10);
  --accent: #8fb8e0; --on-accent: #0d120e; --focus: #8fb8e0;
  --good-text: #0ca30c; --critical: #ef7a72;
}
```
Risk: a navy accent sits nearer the `--s1` system blue (ΔE 19.8 light, 17.1 dark) than spruce does. It is
still clearly separable, but the tabs and the "system" chart series would share a blue family.

## 3. Typography

- **Instrument:** IBM Plex Sans (variable, already vendored) and Plex Mono 400/500 for quantities only. No change.
- **Editorial serif: Source Serif 4** (Adobe, SIL OFL 1.1). Google Fonts family name `Source Serif 4`.
  Vendor two latin-subset woff2 files: **500 normal** and **500 italic** (every serif use is weight 500:
  `.lede`, `.figure-heading h2`, `.start-panel > h2`, `.privacy-claim`, `.pipeline > h2`, `.hero-num`, and the
  italic in `.lede em` and `.field-note h3`). Add them to a `serif.css` beside `plex.css` with the same
  `unicode-range` and `font-display: swap`. If the size budget allows, request the `opsz` axis (8..60) and set
  `font-optical-sizing: auto` so 58px headlines get the display cut.
  Fallback stack: `"Source Serif 4", "Source Serif Pro", Charter, "Iowan Old Style", Georgia, serif`.
  Why: it is a sturdy transitional text face of the kind printed reference guides use, with open counters
  and a working italic, and it shares Plex's rational, engineered proportions. Georgia is a 1990s screen
  default that every OS shows for "serif", so it reads as no choice at all.
- Set serif tracking to about −0.015em. The current `-.045em` on `.lede` was tuned for nothing in particular and will
  crowd Source Serif.

| role | face | size / line-height | weight | where |
|---|---|---|---|---|
| lede | serif | clamp(38px, 4.2vw, 58px) / 1.06; phone 40px | 500 | `.lede` |
| section h2 | serif | 26px / 1.22; phone 23px | 500 | `.figure-heading h2`, `.pipeline > h2`, `.start-panel > h2`, `.privacy-claim` (unify 26 vs 28) |
| hero number | serif | 42px / 1.02; phone 34px | 500 | `.hero-num` |
| card h2 | sans | 17px / 1.3 | 600 | `.card-head h2` |
| body | sans | 14px / 1.55 (landing prose 15–16px / 1.65) | 400 | `body`, `.landing-sub`, `.field-note p` |
| small | sans | 12px / 1.5 | 400 | `.card-sub`, `.note`, `.ctl-note`, `.figcap` (13px) |
| micro | sans | 11px / 1.4, +0.06em, caps | 500–600 | `.eyebrow`, `.tile .k`, `thead th`, `.group > summary` |

## 4. Accent and semantic colours

- **Accent vs `--good-text`.** The current `#28604b` (44.5% 0.069 166°) and `#006300` (43.3% 0.147 142°) are
  ΔE(OKLab×100) **8.9** apart at equal lightness, so the verdict pill and the primary buttons do read as one green.
  Spruce `#145a58` moves the hue 26° toward blue-green at less than half the chroma: ΔE **11.6** in light and
  23.7 in dark (`#7ad0c5` vs `#0ca30c`). The pill then reads as saturated grass green and the actions as muted
  spruce. Keep `--good-text #006300` / `#0ca30c` as validated (7.40:1 light, 5.18:1 dark on surface).
- **Critical in dark mode:** add `--critical: #ef7a72` to the dark set. The inherited `#d03b3b` is 3.62:1 on
  the dark surface and is used as text (`.pill-bad`, `.field-error`). Light `#d03b3b` stays (4.72:1).
- **Series `--s1..--s8`: no hex changes needed.** The new light surface `#fcfdfe` is within 0.002 L of the
  validated `#fcfcfb`, so ratios are unchanged: s1 4.34, s2 3.14, s3 2.76, s4 2.13, s5 2.64, s6 4.86,
  s7 8.40, s8 3.88. The existing WARN on s3/s4/s5 is still discharged by legend + table twin. On `--page`
  (only the hero figure sits there, and it has its own surface) s4 drops to 1.97, so no series mark may sit
  directly on `--page`. Dark set vs `#151b1e`: all ≥ 3.52 (s6 lowest). Re-run
  `validate_palette.js --mode dark --surface "#151b1e"` once the tokens land, as a formality.
- **Heat map:** the ramp is `mix(--neutral-mid, --s1|--s8, 0.1…1)` (heatmap.js:104, 148). The only change is
  the midpoint, which becomes truly achromatic (`#eaeaea` / `#353535`). The override never set `--neutral-mid`,
  so today it is the warm `#f0efec`. The faintest cells against the card are 1.18:1, as before; tie-break
  rings and the table carry the plateau.
- **Two series-colour misuses that make the page warmer than the palette:**
  `.field-note { border-left: 3px solid var(--s2) }` is decorative use of a data colour. Change it to `var(--accent)`.
  In the hero SVG, `tag("What the roof makes", …, "var(--s2)")` (app/ui/landing.js:139) is text at 3.14:1.
  Set the label fill to `var(--ink-2)` and keep the orange line and area.

## 5. Selector changes and consolidation (Marine layer)

**Delete these and fold them into the base token blocks (lines 16–88):** the three override `:root` blocks
(638–662), the three `--on-accent` blocks (663–667), and `--editorial` (649). There should be one light set and
one dark set, as in §2a. Replace the three hard-coded `#fff` with `var(--on-accent)` in place
(`.seg button[aria-pressed="true"]` L334, `.btn-primary` L342, `.rail-jump` L530), then delete override L668.

**Change under the new direction:**
- `.lede em` (691): `color: var(--accent)` → `var(--ink-2)`. Keep the italic second line; reserve accent colour for things you can act on.
- `.lede` (690): `letter-spacing: -.045em` → `-0.015em`; size per §3.
- `.field-note` (714): border `var(--s2)` → `var(--accent)`.
- `.privacy-claim` (708), `.start-panel > h2` (703): 28px → 26px to match the section-h2 step.
- `.data-actions-menu` (774): `box-shadow: 0 8px 24px #0002` → `var(--shadow-pop)`.
- `.btn-primary:hover` (669): delete the `filter: brightness(.94)` rule. The base `color-mix(... 88%, #000)` (L343) already does this job, and the two rules fight.
- `.hero-band` (603): drop the needless `var(--ink-3, var(--ink-2))` fallback.

**Rules that duplicate or fight the base. Merge each into its original rule and delete the patch:**
- `.eyebrow` 689 vs 115; `.lede` 690 vs 133; `.landing` 684 vs 127; `.landing-head` 685 vs 128; `.landing-sub` 692 vs 135;
  `.hero-figure-wrap` 697 vs 141; `.figcap` 700 vs 146; `.landing-grid` 701 vs 148; `.dropzone` 705 vs 162;
  `.privacy` 707 vs 181 (base border is overridden to 0); `.privacy-claim` 708 vs 182; `.calls li` 713 vs 184 (and again at 559/764).
- `.pipeline` 717, `.pipe` 719, `.pipe-step` 720, `.pipe-body` 722 vs 191–200. `.pipe-glyph, .pipe-arrow { display:none }` (723) leaves the
  base rules at 198 and 201–205 (plus the 760px query) dead, so delete those as well.
- `.topbar` 724 vs 232; `.tabs button` 725 and `[aria-selected]` 726 vs 254/259; `.headline` 727 vs 369; `.hero-num` 728 vs 376;
  `.card-sub` 730 vs 353; `.pane` 731 vs 269; `.tile .k, thead th` 732 vs 395/412; `.ctl-note` 678 vs 298; `.ctl-head label` 679 vs 296;
  `.group > summary` 680 vs 277; `.btn-lg` 673 vs 344; `input[type=range]` 674 vs 305; form `min-height` 675 vs 319; `.btn` 670–671 vs 336.
- Media-query conflicts: in `@media (min-width:1001px) and (max-width:1300px)` L737, `.headline` is set to one column, then L783 sets it back to
  two. Keep one block with the L783 intent. `@media (max-width:560px)`: L562 makes `.topbar-right` flex, then L788 makes it grid. Keep the
  grid and delete the flex. `.section-jumps` is declared twice (780 and 791), so merge them.
- After the merge, the "Field-guide identity" comment (636) should become the file-header description. Replace the "Palette:" paragraph at
  lines 4–9 with: "Marine layer: cool fog-grey paper, slate inks, spruce actions; chart series unchanged."

**Unchanged (keep as they are):** `.roof-mark` (681–683, already on `--accent`), `.pipe-step strong::before` numbering (721), the 3px accent
rules on `.hero-figure-wrap` and `.headline`, `.tile.key`, `.skip-link`, `tr.is-best` (s1 tint = "system", correct).
