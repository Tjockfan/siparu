/**
 * When the open-door notice is put in front of a reader, and when it is not.
 *
 * The condition it reports is standing, not an event: Signal K was started without security and
 * stays that way until somebody goes and fixes it. A notice that says so once and never again
 * lets an open server be forgotten; one that says so on every screen spends a tenth of a phone
 * on a sentence the owner read weeks ago. So it is shown, acknowledged, and shown again a month
 * later if the door is still open - and between those the condition keeps a mark on the screen
 * that opens the same page.
 *
 * The clock is passed in rather than read here so the rule can be tested at both edges of the
 * month rather than at whatever moment the suite happens to run.
 */

/** Where the acknowledgement lives. Per device, like every other browser preference here. */
const KEY = "sp:security-ack";

/** How long an acknowledgement holds. A month, counted in days rather than by the calendar:
 *  what matters is that the reminder is rare, not that it lands on the first of the month. */
export const ACK_DAYS = 30;
const ACK_MS = ACK_DAYS * 24 * 60 * 60 * 1000;

/**
 * Should the notice open, given when it was last acknowledged?
 *
 * `null` is a device that has never seen it - a new browser, cleared site data, a second phone -
 * and each of those is a person who has not read this. So is a torn value: a store that cannot
 * be read is not evidence the warning was, and the cost of being wrong here is one dialog
 * against an open door nobody was told about.
 */
export function noticeIsDue(now: number, acknowledgedAt: number | null): boolean {
  if (acknowledgedAt === null || !Number.isFinite(acknowledgedAt)) return true;
  // A stored time in the future is a clock that has since been corrected, or one device's idea
  // of now written by another. Treated as due rather than trusted for up to a month.
  if (acknowledgedAt > now) return true;
  return now - acknowledgedAt >= ACK_MS;
}

/**
 * The whole decision, in one place a test can reach.
 *
 * The component around this can only be rendered to markup here, and markup is drawn before any
 * effect runs - so a test that asked the component whether it had opened would be reading an
 * empty string and calling it an answer, whatever the arguments. The rule lives here instead,
 * and what the component holds is the wiring.
 */
export function noticeShouldOpen(opts: {
  /** The server says it has no account on it. Undefined while the first status is in flight. */
  securityOff: boolean | undefined;
  /** The reader is already on the page that explains the fix. Interrupting that with the
   *  complaint is the product talking over its own answer. */
  onHelpPage: boolean;
  now: number;
  acknowledgedAt: number | null;
}): boolean {
  if (opts.securityOff !== true) return false;
  if (opts.onHelpPage) return false;
  return noticeIsDue(opts.now, opts.acknowledgedAt);
}

/** The last acknowledgement this device recorded, or null if it has none it can read. */
export function readAck(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function writeAck(now: number): void {
  try {
    globalThis.localStorage?.setItem(KEY, String(now));
  } catch {
    // A browser refusing to store it (private mode, a full quota) has read the notice all the
    // same; it will simply be offered again next time. The condition is what matters, not the
    // record of having mentioned it.
  }
}
