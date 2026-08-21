import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./swiss.css", import.meta.url)), "utf8");

/**
 * Every rule that paints with `--on-block`, listed by the selector it belongs to.
 *
 * The token is white in the day theme, which is also the colour of `--cell`, so it
 * reads only against an `--accent-block` fill. A rule that reaches for it over a
 * cell paints white on white and shows nothing: that is what happened to the
 * Voyage screen's distance figure, which was the largest number on the screen and
 * simply was not there for anyone running the light theme. It survived because a
 * banner that had been an accent fill was changed to a cell and two rules stayed
 * behind, and because the night theme's `--on-block` is off-white enough to look
 * deliberate.
 *
 * The list is the point. Adding to it is allowed and is exactly the moment to
 * check what the new rule is painted on; a test that only counted them would go
 * green for a fourth rule on a white card.
 */
const ON_ACCENT_FILL = [".swiss .btn.primary", ".swiss .pair.asking .t"];

/** Selectors of every rule whose body mentions `var(--<token>)`. */
function selectorsUsing(token: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m !== null; m = rule.exec(css)) {
    const [, selector = "", body = ""] = m;
    if (body.includes(`var(--${token})`)) out.push(selector.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("swiss tokens", () => {
  it("paints with --on-block only on an --accent-block fill", () => {
    expect(selectorsUsing("on-block").sort()).toEqual([...ON_ACCENT_FILL].sort());
  });

  /**
   * Both themes are glass now, and glass is a construction rather than a colour: a sheet, a
   * blur to give it something to be in front of, and a ground for that blur to work on. Day
   * shipped for a while with the tokens set to "no glass" (zero blur, transparent ground) and
   * a comment saying so, which is a reasonable state to be in and an easy one to fall back
   * into by editing one value. These are the three that cannot go back on their own.
   */
  it("gives the day theme a real ground to lie on", () => {
    // The selector as it is written, not the substring: the file names the day theme in a
    // comment first, and slicing from that read the NIGHT block and passed on its values.
    const at = css.indexOf(':root[data-theme="day"] {');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    const value = (token: string) =>
      (block.match(new RegExp(`--${token}:\\s*([^;]+);`)) ?? [])[1]?.trim();
    // A zero blur has nothing to blur; a transparent ground leaves it nothing to blur.
    expect(value("pane-blur")).not.toBe("0px");
    expect(value("ground-lift")).not.toBe("transparent");
    expect(value("ground-warm")).not.toBe("transparent");
    // And the sheet has to stay off pure white, or it is not lighter than anything.
    expect(value("pane")).not.toBe("#ffffff");
  });

  it("declares --on-block and --accent-block together, wherever either is set", () => {
    // A block that sets one without the other inherits the odd one out from
    // whatever was declared last, which is how a fill and the text on it come to
    // be the same colour. Counted rather than pinned to a number, because the
    // themes are not the only place a block gets its own values: print is one too.
    const onBlock = css.match(/--on-block:/g) ?? [];
    const accentBlock = css.match(/--accent-block:/g) ?? [];
    expect(onBlock.length).toBe(accentBlock.length);
    expect(onBlock.length).toBeGreaterThanOrEqual(2);
  });
});
