# UX audit: navigation, readability, consistency (read-only, observed in browser)

Screenshots in `.playwright-mcp/audit/`: `landing-{1440,390}-{light,dark}`, `dashboard-{1440,390}-light`, `dashboard-1440-dark`, `quote|roof|loads|bills|assumptions-{1440,390}-light`, `assumptions-1440-dark`, `rail-open-1440-light`. The 1440 tab shots are 1800px tall viewports so the whole pane is visible.
Note: the app shell scrolls inside `main#pane` / `aside.rail` (document height = 100vh on desktop), so fullPage screenshots only capture one viewport. Same for any print or capture tooling.

## Summary of the biggest findings
1. The landing (serif editorial, hairlines, "field note") and the app shell (sans, boxed cards, pills) are two products. The app has no serif, no field-note motif, no numbering.
2. The Quote tab is an empty pane (`quote-1440-light.png`) while its real form lives in the rail; on mobile the form is below the fold behind a floating button.
3. Mobile top bar eats ~280px before any content (`dashboard-390-light.png`).
4. Too many small uppercase micro-labels and 11-13px text.

## A. Navigation

P0
- Quote tab: the form is in the left rail and the main pane is one explanatory card, then 1200px of nothing (`quote-1440-light.png`). Nothing says "start here". Fix: render the quote form (size, batteries, price, production) in the pane as the primary card, with the verdict beneath once filled; the rail keeps only financing/incentives. `app/tabs/quote.js:125`.
- Quote sub copy "Enter its numbers in the Your quote settings panel. On a phone, Settings is below this message." is shown on desktop too and is awkward ("the Your quote settings panel"). Fix: viewport-specific copy or drop it once the form is in the pane. `quote.js:125`.
- Mobile: settings are placed after the pane content and reached by a floating "Settings ↓" pill (`quote-390-light.png`: the pill sits on top of the "Settings" heading itself). On Quote and Roof this hides the primary input. Fix: on mobile, put the tab's primary inputs inline in the pane; keep the pill only on Dashboard and Bills, and hide it once the Settings section is in view. `styles.css:517-533`.

P1
- Tab strip has no hint of what each tab is for; "Quote", "Roof", "Loads" are insider terms, and "Assumptions" reads as boilerplate though it holds the data and rate provenance. Fix: verbs or one-word sub-labels ("Roof: where panels go", "Loads: what moves"), or number tabs 1-5 to show the intended order. `index.html`/tab labels, `styles.css:250-259`.
- Dashboard hero action row "Make this answer yours: Check my roof / See my bills / Compare a quote" (`dashboard.js:76`) sits at the bottom of the hero, after the dense tile grid; it is easy to skip. The three chips are identical in weight and two tabs ("Roof", "Bills") are also in the tab strip directly above. Fix: promote to a labelled "Next steps" strip with a one-line reason each (e.g. "Roof: you gave 1 face, 40 panels"), mark which are already done (roof entered = check mark).
- "Make this answer yours" appears again as "What to try next" chip cloud lower on the page (`dashboard-1440-light.png`, bottom right): same chip style, different purpose (one is navigation, the other applies a scenario). Fix: navigation chips get an arrow plus a different shape; scenario chips get a "tries it" label.
- Bills & money "On this page" jump chips (`bills-1440-light.png`) are good but they are buttons styled like the scenario chips, are not sticky, and "Monthly outlay", "Check a bill" do not match the card titles ("Your first year, month by month", "Does the model match your paper bill?"). Fix: match labels to card titles, make the nav sticky under the tab strip, highlight the current section. `bills.js:53`.
- Left rail: 12 accordion groups on the Dashboard, all collapsed, labels in caps with no hint of content or whether anything is changed from default (`rail-open-1440-light.png`). Opening one closes the others (accordion) which is surprising when comparing. Fix: show a value summary at the right of each closed group ("$2.75/W · $1,000/kWh"), a dot when non-default, and allow several open.
- Assumptions: the rail contains only "Reading this tab / Jump to" dropdown above an empty rail (`assumptions-1440-light.png`). The dropdown duplicates what a sticky in-page contents list would do. Fix: replace with an anchor list in the rail.
- Top bar: "Feedback" is a bare text link while four other actions are buttons; "Share link" is the only primary, yet Share is not the main task; "Change household" and "Data & settings" overlap in meaning. Fix: group into one "Household" menu (change, data) and one "Share" menu (link, copy summary); keep Feedback in the footer. `styles.css:231-245`.
- Landing after "Change household": "Your current results are still here..." banner is placed between the demo drop zone and the location form, inside the form card (`landing-1440-light.png`). Fix: move it above the hero as a slim bar.

P2
- Dashboard grid has no section heading; "Which system size wins" and "The money over time" are peers of "Flexible load" and "What to try next", which are tools. Add small group titles ("The answer", "Why", "Try it").
- Demo-vs-own household chip is the only place that says you are looking at demo data; make it a persistent top strip with "Use my numbers".

## B. Hierarchy and readability

P0
- Font sizes in `styles.css`: 10, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 19, 20, 22, 24, 30, 34, 40, 42, 48 px (19 distinct). Most body prose in cards is 12-12.5px (29 declarations at 12px, 20 at 11px). Card prose and `.card-sub` (`:353`) at 12px grey is below comfortable reading size, especially the tab-long paragraphs on Roof and Assumptions. Fix: define a 6-step scale (11 label, 13 secondary, 15 body, 18 card title, 24 section, 40+ display) as tokens and nothing under 12px for text; body prose 14-15px.
- Assumptions "Rates, effective dates and confidence" table has a 15-line paragraph in one cell next to the value, and a Confidence column whose pill floats at the top of the row, misaligned with the label (`assumptions-1440-light.png`, y 630-930). Value column right-aligned with mono text, the third column left-aligned prose. Fix: make each row a stacked block: label + value + pill on a line, note below at 60ch, collapsed to two lines with "Show derivation". `tabs/assumptions.js`.

P1
- All-caps micro-labels are everywhere: rail group titles (`:116`), tile labels (`:395`), table headers (`:412`), tags (`:477`), card pills ("MAX NPV", "PAID IN CASH", "1 TOTAL · 1 DETECTED"), hero eyebrow ("VALUE OF THIS SYSTEM VS. LEAVING THE MONEY INVESTED" wraps to two caps lines, `dashboard-1440-light.png`). Fix: keep caps only for one role (eyebrow/section marker), set tile labels and table headers in sentence case 12px medium weight; rewrite the hero eyebrow as a sentence: "What this system is worth versus leaving the money invested".
- Card subtitles repeat or over-explain their title: "Which system size wins / Every cell is a full hourly simulation..." is fine, but "The money over time" subtitle is a 5-line, 560px paragraph; "Same system, every rate plan" subtitle restates it (`bills-1440-light.png`). Fix: one sentence max under each title, move the rest to the existing "How to read this" disclosure.
- Line lengths: `.card-sub` max 74ch, `.heat-margin` 78ch, `.method` 78ch, `.disclaimer` 78ch; all fine in cards but Roof/Assumptions paragraphs and the dashboard heatmap footnotes ("Flat region..." and "SCE sizing line...") run 12px bold plus regular in 85-95ch blocks (`dashboard-1440-light.png` y 760-880). Fix: cap at 66ch, split the two notes into separate callouts with an icon/rule.
- Dashboard heatmap footnotes: the "Cap the search at 28" chip sits inline at the end of a sentence and wraps weirdly (`:871`). Fix: put as a right-aligned button under the callout.
- Number formatting: "$5.03/W sticker" and "$2347/kWh sticker" (no thousands separator, `bills.js:216`, `toFixed`) vs "$2,929", "$4,603" elsewhere; "$16k"/"$30k"/"$250k" abbreviations in hero and charts vs full "$2,569" in prose; "$2.75 /W" and "$1,000 /kWh" in the rail have a space before the unit, but "$0.187/kWh" does not; "254×/yr" vs "254 x"; "0 months ago" (`assumptions.js:193`) reads as a bug (file compiled 2026-10-03). Fix: one `fmt.money(v, {compact})` and a rule: compact only in charts and hero, full everywhere else; units attached without space; "compiled today".
- Mono font use is inconsistent: values in the Loads detector card, the Assumptions "Your data" table, the Roof coordinates and footprint, and slider values are mono; the dashboard tiles, tables on Bills, and the "Optimiser's pick" line are not (`dashboard-1440-light.png` vs `loads-1440-light.png`). The "Flexible load" card mixes: "Electric vehicle 3,582 kWh/yr · as recorded" mono next to sans prose. Fix: mono only for tabular quantities in tables and rail sliders; tiles and prose in sans with `font-variant-numeric: tabular-nums`.
- Hero verdict "$16k" is a big green serif number with no unit label (is it NPV? 25-year?). The eyebrow above says "Value of this system vs leaving the money invested". Fix: caption directly under the number: "better than investing the same cash, over 25 years".

P2
- Roof tab headings are questions in sentence case with the hint on the same line in grey ("How steep is it? Roofers name a pitch...") which reads as one run-on line (`roof-1440-light.png`); put hint below.
- Legend text 11px grey under charts; the bill chart legend (7 items + a note) runs across the full width.

## C. Consistency

P1
- Landing vs app: serif display (`--editorial`, `styles.css:649-728`) is only used on the landing and `.hero-num`; app card titles are 15px bold sans. Landing cards have square top-rule accents ("field note" with 3px accent line, `.field-note`), the app uses rounded 1px-border cards with pills. Fix: carry two or three landing motifs into the app: the serif for card titles and the hero number, the top accent rule on the key card, the "01 /" numbering for sections.
- Buttons: `.btn` (grey), `.btn-primary`, `.chip-action` (pill, 999px), `.seg button`, rail "Cap the search" chip, "Change" small button, text-link disclosures; there are at least four silhouettes (rect 2-4px, pill, dashed box "Add a load" items, grey tile choice cards on Roof). Heights differ (36 vs 44 at 700px, `:670`, `:745`). Fix: three shapes only: primary, secondary, and inline link; all with the same radius token.
- Radii: values in use 0, 1, 2 (x10), 3, 4, 8, `--r-sm`, `--r-md` (x8), 999px (x6), 50%. Fix: `--r-sm` for controls, `--r-md` for cards, 999px only for status dots. Pills for status AND for action chips AND for section jumps makes pills meaningless.
- Pills/tags: `.tag` (10px caps, border), `.pill`, `.chip` (header), `.chip-action`, the "YOURS" tag in tables butts directly against the plan name with no gap (`bills-1440-light.png`, "TOU-D-PRIME[YOURS]"), "DEMO HOUSEHOLD" is amber filled while "YOUR HOUSEHOLD" is green outline. Fix: one tag component with margin-left, three tones.
- Disclosures: text-link style "▸ Show the year-by-year table", "What do these numbers mean? ▸" (arrow on the right), "▶ See network requests" (landing, solid triangle left), rail groups (chevron left, caps, hairlines). Four arrow styles. Fix: one summary component: chevron left, same weight, same colour.
- Tables: Bills tables use caps tracked mono headers with right-aligned numbers, the Assumptions table uses a different column rhythm, Roof table lacks row rules. Fix: one `.table` style.
- Legends: swatch+label inline in charts (Bills), as heatmap gradient (Dashboard), and as dots, in Loads the "As recorded"/"As scheduled" legend shows two lines but only one is drawn when the schedule equals the recording (`loads-1440-light.png`): explain "no change" instead.
- Card widths: Loads and Roof cards stop at ~1050px, leaving a dead right third of the pane, while Dashboard and Bills run full width (`loads-1440-light.png`). Fix: pane max-width token for all tabs, or two-column layouts consistently.
- Shadows: `--shadow` only on the floating button plus a hard-coded `0 2px 8px rgba(0,0,0,.25)` (`:531`), and `0 8px 24px #0002` on the data menu (`:774`) which ignores tokens.

P1 dark mode
- Hard-coded colours that bypass tokens: `color: #fff` on `.seg button[aria-pressed]` and `.btn-primary` (`:334, :342`, fixed in dark by `--on-accent` only for some), `#0002` shadow (`:774`), `rgba(0,0,0,..)` (`:531`), `#fff` ink tokens. In dark, the hero "$16k" renders as a dull mid-green on near-black and is the lowest-contrast large figure on the page (`dashboard-1440-dark.png`) while the pill beside it is brighter. Fix: use the same on-dark accent token for the figure.
- Dark heatmap: the unsimulated right columns fade to near-background and the legend "worst/best" swatches mix saturated red/blue with dull neighbours (`dashboard-1440-dark.png` y 540-700); the selected ring is white and fine. Charts otherwise took dark backgrounds correctly.
- Tag tones in dark ("HIGH" green outline on dark) are legible but thin at 10px (`assumptions-1440-dark.png`).

## D. "Generic LLM" tells and what to use instead

P1
- Hero: left headline + paragraph + primary/secondary button pair + two grey trust lines ("Free to use · No account · ..."), right card (`landing-1440-light.png`). Distinctive replacement: let the hero chart be the hero. Put the demo day plot full width, headline overlaid in the serif, and make "Explore a demo" a button beside the chart's evening gap ("what is this gap worth?"). The italic "A sound investment?" is the best soul so far; keep it.
- Three-card "Start with what you have / A calculator, not a sales pitch" pair: generic. Replace the privacy card with a one-line ledger-style strip: "Stays on this device. No account. Open source." as a rule across the page.
- "What happens after you drop the file" 5-up numbered row is the standard LLM feature strip. Replace with a real diagram of the 8,760-hour pipeline using the actual demo numbers, or a "field guide" index with plate numbers (Plate 1: your meter ...).
- Eyebrow + big heading + sub-paragraph repeated for every section (`START WITH WHAT YOU HAVE`, `A CALCULATOR, NOT A SALES PITCH`, `FIELD NOTE / 01`). Fix: use the field-note label as the one consistent device and drop the rest.
- App cards: title left, tiny caps pill at right ("MAX NPV", "CASH", "ROOF BUILDER", "DETECTED") on every card, then a grey paragraph. This is the dashboard-template look. Replace the pill with a figure: the card's key number as a margin note in mono ("Best: 1 battery · 16 panels").
- Tile grid for the hero KPIs (6 equal boxed cells with a caps label) is a stock "metrics card" pattern. Replace with a single sentence-led readout in serif ("Pays for itself in 9.3 years, 11.8% a year on the cash") and put the others as small mono marginalia.
- Rounded pill chip clouds ("What to try next") look like prompt-suggestion chips from a chatbot. Replace with a list of scenarios as rows with the delta in mono at right ("Switch to SCE bundled  +$202/yr"), which also makes them scannable.
- Emoji: none found. Gradients: none, which is good. Shadows are minimal; the amber/red/blue heatmap is the most distinctive element and is already doing identity work.

## E. Mobile (390x844)

P0
- No horizontal page overflow (scrollWidth 390) on any tab, good. Document heights: Dashboard 4797px, Assumptions 13079px, Roof 3826px.
- Header block: wordmark, a 3-line chip, four stacked buttons (2x2) and "Feedback" take ~280px; the sticky tab strip only appears after scrolling (`styles.css:517-533`, `:560-568`, `:787-789`). Fix: collapse the top bar to wordmark + chip + a single "⋯" menu; keep tabs directly below at the top.
- Tab strip is cut at the right ("Assu…") with the scrollbar hidden (`:537-538`), no scroll cue (`assumptions-390-light.png`). Fix: fade/chevron edge, auto-scroll the active tab into view; or shorten labels ("Bills", "Facts").
- "Settings ↓" floating pill covers content on every screenshot (e.g. `dashboard-390-light.png` hides the "SELF-SUFFICIENCY" tile; `quote-390-light.png` overlaps the Settings heading). It does not auto-hide when Settings is visible and is 40px tall at the very bottom where it fights browser chrome. Fix: hide on scroll down, show on scroll up; hide when the settings section is in view; or replace by a sticky bottom bar of two actions.

P1
- Dashboard tiles go 2-up with 10px caps labels (`dashboard-390-light.png`); good density but the tile "BACKUP POWER" body wraps to 3 lines.
- Jump chips on Bills wrap to 2 rows (`bills-390-light.png`), acceptable; make them one horizontally scrolling row so the first card is higher.
- Small targets: 1 interactive element under 32px detected; the disclosure text links ("What do these numbers mean? ▸", "Show the year-by-year table ▸") are ~12px text with no padding and are the main way to reach detail. Fix: min-height 44px for summary rows.
- Loads: slider thumbs are small and the "Scale" slider is clipped by the floating pill (`loads-390-light.png`).

P2
- Charts at 390: bill chart has 24 monthly bars with tick labels that crowd; show every 3rd label.
- Landing at 390: both CTAs are full-width stacked and fine; hero chart is legible but its in-chart annotation text is ~8px.
