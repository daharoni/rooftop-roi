# 03 CSS consolidation audit: app/styles.css (796 lines)

Read-only audit. Line numbers refer to the current file. A second stylesheet exists: app/roof/roof.css (roof builder, `rb-*` classes, loaded at runtime by roofBuilder.js:71). It uses tokens only (14x --r-sm, 9x --sunken, 7x --border) and must keep working when tokens are renamed.

## 1. Token layer

### Defined (line) and redefined by the override block
| Token | Base (light / dark) | Redefined at | Notes |
|---|---|---|---|
| --page, --surface, --sunken, --ink, --ink-2, --ink-3, --grid, --rule | 19-26 / 54-61, 73-80 | 639-646 light; 653-654, 659-660 dark | fully replaced; base values dead in every mode |
| --accent | 40 (= var(--s1)) | 647 / 655 / 661 | base is dead |
| --focus | 41 / 68 / 87 | 648 / 655 / 661 | base dead |
| --border | 27 (rgba ink 10%) / 62 / 81 | not redefined | still black-based, neutral, not tuned to the new warm paper |
| --shadow | 28 / 63 / 82 | not redefined | used once (501) |
| --neutral-mid | 29 / 64 / 83 | not redefined | not used in CSS; read by JS (dom.js TOKEN_KEYS, heatmap.js:148) |
| --s1..--s8 | 31-32 / 65-66 / 84-85 | not redefined | chart series; CSS uses only s1 (198, 415 ), s2 (714), s3 (181) |
| --good, --warning, --serious, --critical | 34-37 | not redefined, no dark variants | |
| --good-text | 38 / 67 / 86 | not redefined | |
| --sans, --mono | 43-44 | not redefined | |
| --rail, --r-sm, --r-md | 46-48 | not redefined | |
| --editorial | 649 only | new | Georgia; 7 uses (690, 699, 703, 708, 715, 718, 728) |
| --on-accent | 663 / 665 / 667 | new | 1 use (668) |

Structure problem: three mode blocks (light :root, `@media dark :root:not([data-theme=light])`, `:root[data-theme=dark]`) appear twice (16-88 and 638-667), plus --on-accent as a third light/dark pair (663-667). Dark values are duplicated verbatim between the media block and the attribute block (51-70 vs 71-88; 651-657 vs 658-662).

### Defined but never used
- --serious: no use in styles.css; one use in roof.css only.
- --neutral-mid: no CSS use (JS only; keep as chart token).
- --rail: used once (261); fine.
- --s4 to --s8: no CSS use (JS charts only; keep).
- --good (34): used 2x (479, 619). Fine.
- --shadow: one use. --focus: one use (111).
- `.hero-band` uses `var(--ink-3, var(--ink-2))` (603) and `.retime-v` uses `var(--good-text, var(--ink))` (609): fallbacks are dead, tokens always exist.

### Hard-coded colors outside token blocks
| Line | Selector | Value | Replace with |
|---|---|---|---|
| 334 | .seg button[aria-pressed=true] | color #fff | var(--on-accent) (already patched at 668) |
| 342 | .btn-primary | color #fff | var(--on-accent) (patched at 668) |
| 343 | .btn-primary:hover | color-mix(... #000) | patched at 669 with filter; pick one |
| 530 | .rail-jump | color #fff | var(--on-accent) (patched at 668) |
| 531 | .rail-jump | box-shadow rgba(0,0,0,.25) | --shadow-pop token |
| 774 | .data-actions-menu | box-shadow 0 8px 24px #0002 | --shadow-pop token |
| 207 area / 331 | .seg | none | clean |
All other color literals are inside :root blocks. Dead-literal check: lines 334, 342, 530 `#fff` are overridden by 668, so deleting them is safe.

Other literal non-color tokens-in-waiting: 607 `.retime` border-radius 8px (not on scale); 774 menu has no radius.

## 2. Duplicate and conflicting rules (later wins; earlier dead = D, partially live = P)
| Selector | Earlier | Later | Result |
|---|---|---|---|
| .eyebrow | 115-118 (10px, 600, .09em, ink-3) | 689 (ink-2, 11px, .1em) | P: weight 600 + uppercase survive from 115; fold into one |
| .landing | 127 (max 1080, pad 0 24 72) | 684 (max 1200, padding-inline 40) | P: bottom padding 72 survives; 553 (560px, `padding 0 16 48`) is overridden by 751 (700px, inline 20) only for inline; cascade order trap: 553 < 751 in source and 751 is wider query, so at <=560 inline=20 wins and 16 is dead |
| .landing-head | 128 (padding 40 0 0) | 685 (flex, padding 28 0 22, border) | D for padding; fold |
| .lede | 133 (40px/1.1/600, max 34ch) | 690 (clamp, editorial, max 12ch) | D except `.lede em` color; 554 (560px: 30px) is dead vs 755 (700px: 48px), contradictory: 560px query says 30px, 700px query says 48px, 755 wins at <=560 only if later: 755 is later, so 30px is dead and phones get 48px |
| .lede em | 134 (color ink-2) | 691 (display block, italic, accent) | D |
| .landing-sub | 135 (15px, 16 0 0, max 64ch) | 692 (16px, mt 22, max 45ch) | D partial; 756 sets 15px at <=700 |
| .hero-figure-wrap | 141-144 | 697 | P: bg/surface repeated; border/radius replaced; margin 30px dead (697 margin 0) |
| .figcap | 146 | 700 (13px, lh 1.65, mt 18) | D for size and margin |
| .landing-grid | 148-151 (1.15fr/1fr, gap 22, mt 30) | 701 (1.25fr/1fr, gap 32, mt 0) | 150 dead for gap/mt/columns; only `align-items:start` live. 539, 743 both collapse to 1 col at <=1000 (dup) |
| .panel | 154 | 702 (.start-panel) / 744, 763 (.panel:last-child) | `.panel:last-child` is a structural hack; replace with a class (e.g. .panel-plain on the privacy panel) |
| .dropzone | 162-166 (border-color var(--rule), padding 26 20) | 705 (padding 22 16, border-color accent) | D for padding and border-color. `.dropzone .btn` declared at 170 and 578 (`margin-block:3px`) and 762 |
| .dropzone-note | 169 (12px) | 706 (13px, lh 1.6) | D |
| .privacy | 181 (border-left 3 solid s3, pad-left 14) | 707 (border 0, padding 10 0) | D (s3 border gone) |
| .privacy-claim | 182 (16px/600) | 708 (28px editorial) | D |
| .calls li | 184 (78px col) | 713 (110px); 559 (560px: 1 col); 764 (700px: 1 col) | 78px dead; 559 duplicated by 764 |
| .pipeline | 191 (mt 34) | 717 (mt 48, border-top, pt 24) | P |
| .pipe | 192 (gap 10) | 719 (gap 16) | D for gap |
| .pipe-step | 193-196 (surface card) | 720 (transparent, border-top only) | all of 193-196 dead except flex/position |
| .pipe-glyph, .pipe-arrow | 198, 201-204, 205 | 723 `display:none` | entire glyph/arrow styling dead (198, 201-205 = 6 lines); also check landing.js still emits them |
| .pipe-body | 200 (11.5px) | 722 (13px) | D |
| .topbar | 231-234 (pad 8 18) | 724 (padding-block 12); 534, 560, 738 | 8px dead; wrap rules at 534 (<=1000), 738 (1001-1300) are redundant: wrap applies at all widths <=1300 |
| .topbar-right | 241, 535 (<=1000 wrap), 562-564 (<=560 block), 739 (1001-1300 wrap), 788 (<=560 grid 2 col) | | 562-564 `justify-content/gap` partly overridden by 788 (display grid) at <=560; wrap redundant |
| .tabs button | 254-257 (padding 9 13 8) | 725 (min-height 44), 569 (<=560 padding) | P: compatible, fold |
| .tabs button[aria-selected=true] | 259 (ink) | 726 (accent) | D for color |
| .btn | 336-340 | 670 (min-height 36), 671 (transition), 745 (<=1000 min-height 44) | P, compatible; fold |
| .btn-primary | 342 | 668 (color), 669 (hover bg + filter) | 342 color and 343 hover dead |
| .btn-lg | 344 (13px, 8 16) | 673 (min-height 46, 11 18, 14px, 500) | 344 dead |
| .ctl-note | 298 (11px) | 678 (12px, lh 1.55) | D |
| .ctl-head label | 296 (12px) | 679 (13px) | D |
| .group > summary | 277-282 | 680 (min-height 44) | P |
| input[type=range] | 305-308 (height 18) | 674 (height 28) | D; thumb margin-top -5px at 313 was tuned for 18px track box: re-check at 28px |
| select, input[...] | 319-322 | 675 (min-height 36), 746 (<=1000 44px, font 16px) | P |
| .headline | 369-373 (cols minmax(200,250) / 1fr) | 727 (border-top accent), 542 (<=1000 1 col), 737 (1001-1300 1 col), 783 (1001-1300 `minmax(220,.8fr) minmax(0,1.2fr)`), 766 (<=700 padding 16) | CONFLICT: 737 and 783 are same media, same selector; 783 wins (later) so 737's `.headline` is dead, but 737's `.dash-cols` is live |
| .hero-num | 376 (42px/600) | 728 (editorial/500), 558 (<=560 34px) | P: font-size survives from 376 and 558 |
| .tile .k | 395 (10px) | 732 (11px, shared with `thead th`) | D |
| thead th | 412 (10px) | 732 (11px) | D |
| .card-sub | 353 (12px) lh inherited | 730 (lh 1.6) | P |
| .card-head h2 | none | 729 (17px) | new; h2 base is 15px (106) |
| .pane | 269 (gap 16) | 731 (gap 20); 555 (<=560 padding) ; 520, 549 | 16 dead; 20px vs `.dash-col` gap 16 (361) and `.row2` gap 16 inconsistent |
| .tiles.tiles-3 | 613, 614 (<=700) | | `.tiles` 4 col at 391, 2 col at 543 (<=1000), 784 (headline 2 col at 1001-1300) |
| .section-jumps | 780 | 791 (adds align/padding) | same selector twice, merge; section-jumps-label media at 793 |
| .rail > div > .group:first-child | 266-267 | 526-527 (<=1000) | 526 `border-top:0` duplicates 266; only padding-top 14 vs 11 differs |
| .chip | 236-240 | 787 (<=560 radius 4px) | `999px` pill vs 4px: unexplained shape change |

Count: roughly 30 selectors restyled; about 45 declarations are dead. The base block 127-217 (landing) is roughly 40% dead.

Z-index ladder: 20 (tabs), 30 (rail-jump), 40 (toast), 45 (menu), 100 (skip-link). Keep but define as tokens.

## 3. Scales

### Font sizes (px, count of declarations)
10 (6), 11 (21), 11.5 (4), 12 (29), 12.5 (7), 13 (17), 14 (5), 15 (5), 16 (3), 17 (3), 19 (1), 20 (1), 22 (2), 24 (1), 26 (2), 28 (2), 30 (1), 34 (1), 40 (1), 42 (1), 48 (1), clamp(40,4.5vw,64) (1). 22 distinct values.

Proposed scale (7 steps, rem-free px for now):
| Token | px | Absorbs |
|---|---|---|
| --fs-xs | 11 | 10, 11, 11.5 (labels, eyebrows, tile .k, th, legend, heat axes) |
| --fs-sm | 12 | 12, 12.5 (notes, tables, body UI, inputs) |
| --fs-base | 14 | 13, 14 (body, tab labels, h3, btn-lg) |
| --fs-md | 16 | 15, 16, 17, 19 (h2, privacy-sub, card titles; inputs on touch must stay 16) |
| --fs-lg | 24 | 20, 22, 24, 26 (retime-v, editorial h2/h3, tile .v can use fs-md) |
| --fs-xl | 32 | 28, 30, 34 (editorial section heads, hero-num mobile) |
| --fs-hero | 44 | 40, 42, 48, clamp (hero-num, lede); keep one clamp for .lede |
Tile `.v` (17) -> fs-md. `.hero-num` (42/34) -> fs-hero / fs-xl. Minimum 11 for readable text (10px labels are the smallest at 16, 395, 412 and 115).

### Border radius
0 (2), 1px (1: .legend .sw.line, 439), 2px (10), 3px (--r-sm, 6 uses), 4px (2: 454, 787), 6px (--r-md, 8 uses), 8px (1: 607), 50% (3), 999px (6).
Proposed: --r-sm 4px (absorbs 1, 2, 3, 4), --r-md 8px (absorbs 6, 8), --r-pill 999px; 50% stays for dots. Landing editorial blocks use 0 (697, 720): keep as explicit `0` for "flat editorial" only if that is a deliberate rule, otherwise use --r-md.

### Box shadow
Decorative: --shadow (28, used 501), rgba .25 8px (531), `0 8px 24px #0002` (774). Functional insets (not decoration): 399, 445, 447, 450, 451.
Proposed: one `--shadow-pop: 0 4px 16px` (toast, rail-jump, data-actions-menu), plus keep inset rings as component-local. Delete `--shadow` or make it the single one.

### Spacing (padding / gap / margin on cards, tiles, panels, groups)
Current distinct values: padding card 15/17 (351), 13/14 (557); panel 18/20 (156), start-panel 24 (702), 20/16 (761); headline 14/16 (371), 16 (766); tile 7/10/8 (394); loadcard 12/14 (469); retime 10/12 (607); billform 18/16 (579), 14/12 (598); data-actions-menu 14 (774); banner 8/11 (493); pane 18/20/48 (269), 14/14/40 (555); rail 0/14/40 (263), 72 (548, 556); group-body gap 11, padding 2/0/15 (289); gaps in use: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22.
Proposed 4px-based scale: --sp-1 4, --sp-2 8, --sp-3 12, --sp-4 16, --sp-5 24, --sp-6 32, --sp-7 48.
Mapping: 1-3 -> 4 (tile gap 1 stays 1px as a grid divider), 5-7 -> 8 (6,7 -> 8), 9-11 -> 12 (9 -> 8 or 12 by context), 13-15 -> 16, 17-20 -> 16 or 24, 22 -> 24, 26-34 -> 32.
Component rules: card padding 16 (13 at <=560 -> 12); panel 24 (16 at <=700); headline 16; tile 8/12; loadcard 12/16; pane gap 24 (currently pane 20, dash-col 16, row2 16, dash-cols 16: all should be one --gap); rail padding 0/16/48.

## 4. Media queries
Used (line): max-width 760 (205), 1000 (517, 741), 560 (551, 786, 793), 520 (595), 700 (614, 750), prefers-reduced-motion (572), min 1001 + max 1300 (736, 782), min 701 + max 1000 (794).
Seven distinct widths: 520, 560, 700, 760, 1000, 1300 (as range top), 701/1001 (as range bottoms).
Overlaps and contradictions:
- <=560 vs <=700: `.lede` 30px (554) vs 48px (755); `.landing` padding 16 (553) vs inline 20 (751); `.calls li` 1 col at 559 and again 764; `.topbar` wrap at 560/534/738.
- 1001-1300: `.headline` grid declared twice in two separate queries (737 single column, then 783 two columns). 783 wins. `.topbar`/`.topbar-right` wrap in 738-739 duplicates 534-535 (<=1000) and the wrap should just be unconditional.
- 760 (pipe-arrow) is moot: arrows are `display:none` at 723.
- 520 (billform) vs 560/700: three near-identical breakpoints.
- <=1000 is the layout switch (workbench stacks; rail below pane), declared in two blocks (517-550 and 741-749, +landing-grid duplicates 539/743).
- .tabs `position: sticky` at <=1000 but `.pane .card scroll-margin-top: 58px` (781) is global while 44px (520-521) is used at <=1000: inconsistent.

Proposed canonical set (mobile-first or max-width, pick one):
- `--bp-sm 600px`: phone: single column grids (slices, bill-grid 3 -> 2, calls, tiles-3, tiles 2), landing paddings, topbar-right grid, lede/hero-num sizes, buttons full-width in dropzone, section-jumps label. Absorbs 520, 560, 700, 760.
- `--bp-md 1000px`: tablet/stack: workbench stack, rail below pane, headline 1 col, dash-cols/row2/landing-grid/landing-hero 1 col, 44px touch targets (CSS vars can not drive queries, so use literal numbers, one comment). Absorbs the 1001-1300 band: either headline and dash-cols stay 1 col up to 1300 (move to a `1300` fourth query, or simply set `.dash-cols` min column widths via `minmax(0,1fr) minmax(0,.9fr)` and let `.headline` use `auto-fit`), recommended: drop 1300 and use `grid-template-columns: repeat(auto-fit, minmax(...))` for `.headline`.
- `--bp-lg 1300px` only if the 1001-1300 band cannot be solved with auto-fit; otherwise two breakpoints suffice (600, 1000).
Single owner per selector: `.headline`, `.dash-cols`, `.tiles`, `.topbar`, `.topbar-right`, `.landing-grid`, `.landing-hero` each appear in exactly one query per breakpoint.
Touch targets (44px) should be gated on `(pointer: coarse)` rather than width (745-746, 768).

## 5. Inline styles in JS (candidates for classes)
Note: CSP style-src has `'unsafe-hashes'` plus one sha256. Inline `style=""` attributes set via `setAttribute` and `el({style})` (dom.js:21 falls to `node.style = ...` through `k in node`) are accepted only because of that hash/unsafe-hashes setup; CSSOM assignments (`.style.x =`) are allowed regardless. Moving to classes lets the CSP drop `unsafe-hashes`. Also index.html:19 `<noscript>` has an inline style (max-width/margin/padding), which is likely what the hash covers: that is the only reason for the hash; put it in a class and remove both.

Proposed utility/component classes: `.stack` (flex column, gap var), `.stack-sm`, `.row-wrap` (flex wrap gap 8, mt), `.mt-1/.mt-2/.mt-3` (4/8/12), `.muted` (color ink-3), `.chart-box.h-90/h-110/h-210/h-230/h-260` (or `--h` custom property set once via `style.setProperty` which is CSSOM-safe), `.btn-sm`, `.btn-left`.

| file:line | inline | proposed |
|---|---|---|
| app/main.js:2001 | margin:8px 16px 0 on #app-banner | `#app-banner` rule in CSS |
| app/main.js:2028 | margin-bottom:6px on .banner | `.banner + .banner` or `.banner-list` gap |
| app/main.js:2031 | flex wrap gap 8 mt 6 | `.row-wrap` |
| app/main.js:726-727 | bar width/visibility (dynamic, CSSOM) | keep; set `--p` custom property instead |
| app/tabs/loads.js:62 | chart-box height 230px | `.chart-box.h-230` |
| app/tabs/loads.js:118 | flex column gap 6 | `.stack-sm` |
| app/tabs/loads.js:119 | text-align:left on btn | `.btn-left` |
| app/tabs/loads.js:121, assumptions.js:314, landing.js:309-310, charts/bills.js:65 | color:var(--ink-3) spans | `.muted` |
| app/tabs/dashboard.js:103 | margin-left:auto on #heat-hint | `.ml-auto` or `.seg-inline`-style |
| app/tabs/dashboard.js:108-109 | chart-box 110px | `.chart-box.h-110` |
| app/tabs/dashboard.js:120, 142 | chart-box 230px | `.h-230` |
| app/tabs/dashboard.js:123 | 90px + margin-top 6 | `.h-90.mt-1` |
| app/tabs/dashboard.js:160 | .note margin-top 8 | `.mt-2` |
| app/tabs/dashboard.js:313, 572 | font 11px padding 2px 9px on btn | `.btn-sm` |
| app/tabs/dashboard.js:240 | npv color (dynamic, token) | class `.pos`/`.neg` |
| app/tabs/assumptions.js:41 | flex column gap 8 mt 12 | `.stack.mt-3` |
| app/tabs/assumptions.js:146-147 | ul margin/padding; li 12px ink-2 mb 3 | `.method ul/li` already styled at 486-487: reuse |
| app/tabs/assumptions.js:243, 245, 258, 264-266, 299, 314, 320, 337, 526 | margins, small btn, h3 margin, dd font-family sans | `.mb-2`, `.btn-sm`, `.kv dd.plain` |
| app/tabs/quote.js:154, 177 | flex gap 8 wrap mt 8 | `.row-wrap` |
| app/tabs/quote.js:259-260 | left/width % (dynamic) | keep (data-driven) |
| app/tabs/quote.js:365 | kv margin 8px 0 | `.kv.my-2` |
| app/tabs/roof.js:63, 64, 107, 116, 121, 128, 132, 133, 135, 138 | tables/rows/flex/field label/box border-radius with tokens | `.roof-row`, `.roof-field`, `.stack`, `.row-wrap`; 132 duplicates `.loadcard` look |
| app/ui/landing.js:157 | display:none on file input | `[hidden]` attribute or `.visually-hidden` |
| app/ui/landing.js:219, 234, 240, 313, 370-373 | stack, ctl-note mt 5, panel-sub mt 14, notice margins | `.stack`, `.mt-*`, `.landing-notice` |
| app/charts/day.js:79, charts/base.js:167, heatmap.js:128,148,188 | background per series/data; font-weight | dynamic color: keep (use `style.setProperty('--c')` + class `.sw`/`.ribbon-seg`); td bold -> `.is-sel` |
| app/charts/heatmap.js:111 | gridTemplateColumns (dynamic) | keep |
| app/ui/summary.js:108-109 | offscreen textarea | `.offscreen` class |
| app/tabs/bills.js:70, 82, 93, 124 | chart-box heights 260/210/210/230 | `.h-*` |
| app/tabs/bills.js:113, 126, 137, 138 | margin-top 8/14 | `.mt-*` |
| app/roof/roofBuilder.js:303, 339, 463, 470, 536, 565, 566, 584, 912, 917 | marginTop, flex | roof.css `.rb-*` spacing; 994 stripe background is dynamic (keep) |
| index.html:19 | noscript inline block | `.noscript` class in styles.css (or `<style>`-free) |

About 60 inline occurrences; roughly 45 are static layout. Chart heights (10 uses: 90, 110, 210, 230, 260) collapse to 4 classes.

## 6. Orphans
JS classes with no rule in styles.css (verified against all `el("tag.cls")` and `class=` uses):
- `ctl-head-label` (controls.js:246): no rule; the `label` rule at 296 and 679 does not apply to the span, so the label text is unstyled (13px/ink-2 missing). Add `.ctl-head label, .ctl-head-label`.
- `hero-figures` (dashboard.js:71), `hero-intro` (landing.js:43), `landing-location` (landing.js:216; also a querySelector hook at 177), `door` (landing.js:162; querySelector hook), `section-jump` (bills.js:50; only `.section-jumps` is styled): structure hooks with no style; fine if intended, otherwise name hook classes `js-*`.
- `rb-*`: styled in app/roof/roof.css, not an orphan.
- `a.btn` handled at 694.
CSS selectors that match nothing static:
- `.banner-info`: live (landing.js:368).
- `.pill-good/.pill-mid/.pill-bad`: dynamic (dashboard.js:53, 243, 346): live.
- `.pipe-glyph`, `.pipe-arrow` (198, 201-205, 723): styled then hidden; check landing.js emits them, if so remove from markup and CSS.
- `.dropzone .btn` (170, 578, 762), `.billform`, `.bill-*`: live (billform.js).
- `.hero-note`, `.hero-band`, `.hero-why`, `.retime*`, `.qband*`, `.existing-*`: live per dashboard.js, quote.js, existing.js.
- `.chart-fail`, `.heat-*`, `.legend`: live (base.js, heatmap.js).
- `.group > summary::before`, `.seg-inline`, `.config-line`: no problem found.
- `.shell`, `.landing`, `.pane`, `.topbar`, `.tabs`, `.topbar-right`, `.feedback-link`, `.chip`, `.data-actions-menu`: HTML-only, live.
- Unused tokens/vars via selectors: none found beyond section 1. No static class in styles.css was found with zero references (check ran over all `.class` names against app/*.js and index.html).
- `#sources-body li` (515), `#period-ribbon` (462): confirm ids still emitted (not re-checked).

## 7. Proposed consolidated structure
Single file, order, with source ranges folded in (R = range in current file):
1. **Header comment + tokens** (one place)
   - `:root` light: R19-49 (typography, radii, rail) merged with 639-649, 663 (editorial, on-accent). Drop dead base colors (19-26, 40-41).
   - Dark: one block `@media (prefers-color-scheme: dark){:root:not([data-theme=light]){...}}` and one `:root[data-theme=dark]` with identical content (use a shared selector list: `:root[data-theme="dark"], :root:not([data-theme="light"])` inside the media query, which still needs the duplicate; alternative is accept the duplicate with a comment). Include --on-accent, --accent, --focus here, all in the same block per mode.
   - New scale tokens: --fs-*, --sp-*, --r-*, --shadow-pop, --z-*, --h-chart-*.
2. **Base**: reset, html/body, headings, a, :focus-visible, [hidden], .num, .mono, .eyebrow (merge 115-118 + 689), skip-link (733-735), .visually-hidden / .offscreen (new). R90-120, 733-735.
3. **Primitives** (buttons, inputs, switch, seg, chips, tags, notes, kv, table): R305-345 + 236-241, 402-416, 477-483, 593-594, 668-679, 694, 745-746 (as pointer:coarse). Merge .btn / .btn-primary / .btn-lg once.
4. **Surfaces**: .card, .panel, .loadcard, .banner*, .toast, .retime: R351-353, 154-159, 468-475, 492-502, 606-610, 634.
5. **Layout utilities**: .stack, .row-wrap, .mt-*, .muted, .chart-box.h-*, .btn-sm, grid helpers (.row2, .dash-cols, .dash-col, .slices): R355-364 plus new classes from section 5.
6. **App shell**: .shell, .topbar, .wordmark, .roof-mark, .status, .bar, .tabs, .workbench, .rail, .pane, .group, .ctl, .rail-jump, .data-actions*: R224-270, 276-303, 504-505, 681-683, 724-726, 770-775, 781.
7. **Dashboard / result components**: .headline, .hero-*, .verdict-pill, .tiles, .tile, .dashboard-next, .section-jumps, .qband, details.data-view, .method: R369-407, 418-423, 485-488, 601-631, 727-732, 776-779, 791-792.
8. **Charts**: R429-462.
9. **Landing**: single definition each of .landing, .landing-head, .landing-hero, .lede, .landing-sub, .hero-figure-wrap, .landing-grid, .panel/.start-panel/.privacy, .dropzone, .billform, .field-*, .calls, .pipeline/.pipe, .field-note, .landing-foot, .disclaimer, .existing-form: R127-217 (keep only live declarations) + 576-599, 624-634, 684-723, 744, 763. Delete dead pipe-glyph/pipe-arrow styling.
10. **Responsive**: one `@media (max-width:1000px)` and one `@media (max-width:600px)`, each organized by section order above (not by feature), then `(pointer:coarse)` and `prefers-reduced-motion` (R572-574). Replaces 205, 517-570, 595-599, 614, 736-769, 782-796.

### Pure improvements in the override block (move into natural sections, no behavior change)
- Skip link + `body:has(#shell[hidden])` hide: 733-735 -> Base.
- Roof mark (`.roof-mark` + ::before/::after): 681-683 -> Shell (topbar wordmark).
- Touch targets / min-heights: .btn, .chip-action, .seg button 36px (670); .btn-lg 46 (673); inputs 36 (675); .group > summary 44 (680); .tabs button 44 (725); 44px at coarse pointer (745-746, 768); 16px input font on small screens (746, prevents iOS zoom). Slider height 28 (674, re-center thumb).
- `.btn:disabled` cursor/opacity (672); `.btn` transition (671); `.btn-primary` hover via filter (669) replaces 343.
- `.field-row > input { min-width:0 }`, `.field-row > button { flex-shrink:0 }` (676-677): -> Controls.
- `a.btn` inline-flex (694); `.rail-jump` safe-area inset (747); `.loadcards` `min(260px,100%)` (748); `.pane .card scroll-margin-top` (781); `.section-jumps-label` (792).
- `#sources-body li` overflow-wrap (515) stays.
- `.on-accent` color pair (668) replaces three `#fff` (334, 342, 530).

### Cautions for the implementation pass
- Do not rename tokens read by JS: dom.js TOKEN_KEYS lists --ink, --ink-2, --ink-3, --grid, --rule, --surface, --page, --sunken, --neutral-mid, --s1..--s8, --good-text, --critical, --warning. roof.css uses --border, --sunken, --r-sm, --r-md, --warning, --good-text, --serious, --focus, --shadow, --s4.
- A palette agent owns color values; this pass only reorganizes where they live.
- Verify after consolidation with screenshots at 360, 700, 1000, 1200, 1400 in light and dark, on landing and each of the six tabs.
