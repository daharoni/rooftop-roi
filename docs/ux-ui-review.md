# UX/UI sweep — October 2026

## Design direction

A California home-energy field guide: warm paper, forest-green controls, a small roofline mark, editorial serif headings, and IBM Plex for the working interface. Keep the real household-versus-solar chart as the visual signature. Avoid decorative stock imagery and numerical claims that imply a guaranteed investment return.

## Changes in this pass

- Put the purpose, service area, own-data entry and demo above the long explanations.
- Preserve the full privacy/network inventory inside an accessible disclosure.
- Give demo users an explicit identity and a reversible path back to household entry.
- Separate everyday sharing/copying from data management.
- Explain headline value in today's dollars; put roof, bills and quote next steps beside results.
- Add short navigation across the long Bills & money page.
- Explain quote and roof setup in terms that also work on phones.
- Improve touch targets, mobile form text, narrow layouts, readable secondary text, keyboard focus and form descriptions.
- Replace unsupported guarantees in flexible-load and monthly-outlay copy with conditional model language.

## Future ad support

No ad code, analytics, tracking, paid placements or external dependencies are introduced by this pass. The current privacy statements remain promises about the actual application.

If monetization proceeds, design a visibly labeled sponsorship space between the educational landing content and footer first. Keep it outside the calculator's inputs, verdict, tariff selection and installer comparison. Reserve its dimensions to prevent layout shifts. Do not present paid placements as model recommendations. Do not add blank ad slots before inventory exists.

An ad integration is a separate release: choose the actual provider, inspect its requests/storage, update the centralized privacy inventory and CSP for that integration, and check the user-facing disclosures against its behavior. The current “no tracking” promise cannot simply be retained alongside a tracking ad network.

## Remaining product decisions

- Run observed usability sessions with homeowners who have a quote, monthly bills only, and an existing solar system. This engineering sweep is not a substitute for that evidence.
- Consider a dedicated quote-first entry flow after validating whether visitors prefer it over the current household-first comparison.
- Consider a printable result report with the selected system, assumptions, rates' effective dates and questions for the installer.
- Keep the calculation engine independent of sponsors and advertising incentives.

## Verification

- Full Node suite: 440 passed, 3 live-network checks skipped while offline, 0 failures.
- JavaScript syntax and whitespace checks passed.
- Browser walkthrough: all six sections at 390 px; wide dashboard at 1440 px; landing and monthly form reviewed visually. No page overflow found in the inspected mobile layouts.
- Exercised demo entry, household change and return, quote comparison, fast successive numeric edits, bill-section focus jumps, monthly-form errors, and monthly values retained through Back/reopen.
- No browser console errors reported in the walkthrough. Automated calculation tests do not establish financial accuracy or replace user research. Dark-mode tokens are included; a separate visual dark-mode review remains useful.
