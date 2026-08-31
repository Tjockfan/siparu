/**
 * What an open server puts in front of a reader, and what it leaves behind.
 *
 * The condition is standing: Signal K was started without an account and stays that way until
 * somebody goes and fixes it. It used to be said with a banner, which is a fair shape for a
 * standing condition and was measured taking 12.7% of a phone's screen - four lines of a
 * sentence the owner read weeks ago, on the screen he looks at all day.
 *
 * So it is said twice now, and each half has a job the other cannot do. The dialog is read once
 * and dismissed; the mark says the door is still open and opens the page that closes it. These
 * pin the pair against the way it can quietly go wrong: a dialog nobody can dismiss, a mark that
 * outlives the condition, a dialog over the very page it sent the reader to.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import SecurityWarning from "./SecurityWarning";

const at = (path: string, node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

describe("the mark left on the screen", () => {
  it("says nothing at all about a secured server", () => {
    expect(at("/", <SecurityWarning on={false} locked={false} />)).toBe("");
    expect(at("/", <SecurityWarning on={undefined} locked={false} />)).toBe("");
  });

  /**
   * One line, and the way out of it. The whole point of replacing the banner was the room it
   * took, so a mark that grew back into a paragraph would be the same defect in a new coat.
   */
  it("names the condition in one line and offers the page that answers it", () => {
    const html = at("/", <SecurityWarning on={true} locked={true} />);
    expect(html).toContain("sec-flag");
    expect(html).toContain("Signal K security is off · pairing is locked");
    expect(html).toContain("How to fix");
    // The banner's own body is what took the four lines; none of it survives here.
    expect(html).not.toContain("Anyone on this network");
  });

  /** Locked and merely open are different conditions and the line says which. */
  it("distinguishes an open door from a locked one", () => {
    expect(at("/", <SecurityWarning on={true} locked={false} />)).not.toContain("pairing is locked");
  });
});

/**
 * The dialog's own decision is not tested here, and cannot be: markup is drawn before any
 * effect runs, so this file would read an empty string whatever the arguments and call it an
 * answer. The rule lives in lib/securityNotice as `noticeShouldOpen` and is pinned there,
 * against a clock the test sets. What is left for this file is the mark above, which draws in
 * one pass and has no effect behind it.
 */
