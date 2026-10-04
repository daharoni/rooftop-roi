/* =============================================================================
 * ui/feedback.js — the one place the feedback destination is written down.
 *
 * Feedback is a GitHub issue opened from a template, so there is nothing for
 * the page to send and no form to host.  The template asks for a share link,
 * which carries settings but never meter data.
 * ========================================================================== */

import { el } from "./dom.js";

export const REPO_URL = "https://github.com/daharoni/rooftop-roi";
export const FEEDBACK_URL = REPO_URL + "/issues/new?template=feedback.md";
export const FEEDBACK_TITLE = "Report a problem or suggest an improvement. Opens a GitHub issue in a new tab.";

/** A plain external link to the feedback template. */
export function feedbackLink(text = "Send feedback", cls = "") {
  return el("a" + cls, { href: FEEDBACK_URL, target: "_blank", rel: "noopener", title: FEEDBACK_TITLE, text });
}
