/**
 * What decides how wide a screen's content is, in the cases where the answer is written down
 * twice and the two copies can drift apart.
 *
 * None of these widths is a matter of taste. Each comes from something outside the rule that
 * uses it - the lanes a table holds, the paper a record prints on, the figures a module in the
 * webapp measures screens with - and each of those is a second place the same number lives.
 * This file is what makes a drift loud. Quietly, it shows up as a lane drawn half off the edge
 * of a phone, or as a rule ruled across a column that is not there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Comments come out first: this file explains its rules at length above them, so a search for
// a declaration finds the prose before the rule it belongs to.
const css = readFileSync(fileURLToPath(new URL("./swiss.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule in the sheet, as [selector, body]. */
function rules(): [string, string][] {
  const out: [string, string][] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m !== null; m = rule.exec(css)) {
    out.push([(m[1] ?? "").trim().replace(/\s+/g, " "), m[2] ?? ""]);
  }
  return out;
}

/** The one rule that declares a property, by the property's name and what else it mentions.
 *  The sheet sets a max-width in a dozen places; the table's is the one that reads the lane
 *  count, and a search that found more than one of anything is not looking at what it thinks. */
function ruleDeclaring(prop: string, mentioning = ""): [string, string] {
  const found = rules().filter(
    ([, body]) => new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body) && body.includes(mentioning),
  );
  expect(found, `${prop} ${mentioning}`).toHaveLength(1);
  return found[0] as [string, string];
}

const [tableSelector, tableBody] = ruleDeclaring("--lb-tm");
const declared = (name: string): number => {
  const m = new RegExp(`--${name}:\\s*(-?[\\d.]+)px`).exec(tableBody);
  expect(m, `--${name} is declared in px`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
};
/** The same, for the durations. Declared beside the lanes and read the same way. */
const declaredMs = (name: string): number => {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)ms`).exec(tableBody);
  expect(m, `--${name} is declared in ms`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
};

/**
 * The logbook table's own three, which `fitColumns.ts` in the webapp holds a copy of so it can
 * work out how many lanes a narrow screen has room for. That file says in a comment that
 * changing one without the other shows up as a lane drawn half off the right edge; the comment
 * states a condition, so it is a test, and its own suite pins the other half.
 */
describe("the measurements the logbook table is laid out from", () => {
  it("declares them once, on the table itself", () => {
    expect(tableSelector).toBe(".swiss .lb");
  });

  /**
   * The figures fitColumns.ts is holding a copy of. A lane minimum measured against a row that
   * has since changed produces a table one lane too wide for the screen it is on, which is the
   * failure the phone was carrying until the columns were made to fit.
   */
  it("keeps the figures the webapp measures its screens against", () => {
    expect(declared("lb-tm")).toBe(58); // fitColumns.ts: TIME_LANE
    expect(declared("lb-gap")).toBe(4); // fitColumns.ts: LANE_GAP
    expect(declared("lb-pad") * 2).toBe(32); // fitColumns.ts: SIDE_PAD, both sides
    expect(declared("lb-unit")).toBe(104); // fitColumns.ts: UNIT_LANE
  });

  /**
   * The fade and the swap behind it.
   *
   * The table is swapped in JavaScript and faded in CSS, and the two are one motion: the swap
   * has to land while the table is out of sight. A stylesheet slower than the timer shows the
   * new figures arriving under the old table's fade; a stylesheet faster shows the page blank
   * and waiting. So the leaving half is one number written in two files, and this is where they
   * are held to each other.
   */
  it("fades out over exactly as long as the table waits before it swaps", () => {
    expect(declaredMs("lb-fade-out")).toBe(180); // LogbookMarine.tsx: FADE_MS
    // Coming back is the slower half: a table arriving is read, a table leaving is not.
    expect(declaredMs("lb-fade-in")).toBeGreaterThan(declaredMs("lb-fade-out"));
  });

  /**
   * The engineer's table leads with a machine's name as well as an hour, and its head and its
   * rows have to lead with the same two: a head one lane short of its rows puts every reading
   * under the wrong word, which is worse than a table that is too wide.
   */
  it("leads the unit-major head and rows with the same two lanes", () => {
    for (const selector of [".swiss .lb-cols.u, .swiss .lb-row.u"]) {
      const body = rules().find(([sel]) => sel === selector)?.[1] ?? "";
      expect(body, selector).toContain(
        "var(--lb-tm) var(--lb-unit) repeat(var(--lb-cols, 5), minmax(0, var(--lb-lane)))",
      );
    }
  });

  /**
   * A column that asked for two lanes has to be given two, in the head and in the rows alike.
   *
   * fitColumns decides that a position costs two lanes and reserves them; this rule is what
   * actually spends them. Without it the reservation still holds - the table is a lane wider
   * than it needs - but the position is drawn in the first of its two lanes and overprints the
   * column beside it, which is the defect the pair was introduced to fix. A head that spans and
   * rows that do not is worse still: every reading then sits under the wrong word.
   */
  it("spends the second lane in the head and the rows together", () => {
    const spans = rules().filter(([, body]) => /grid-column:\s*span 2/.test(body));
    expect(spans, "one rule spans two lanes").toHaveLength(1);
    const [selector] = spans[0] as [string, string];
    expect(selector).toContain(".swiss .lb-cols span.w2");
    expect(selector).toContain(".swiss .lb-row .v.w2");
  });

  /** Both grids read the declarations, so neither can drift from the width below. */
  it("draws the head and the rows from those declarations rather than from figures", () => {
    for (const selector of [".swiss .lb-cols", ".swiss .lb-row"]) {
      const body = rules().find(([s]) => s === selector)?.[1] ?? "";
      expect(body, selector).toContain(
        "var(--lb-tm) repeat(var(--lb-cols, 5), minmax(0, var(--lb-lane)))",
      );
      expect(body, selector).toContain("gap: var(--lb-gap)");
      expect(body, selector).toContain("var(--lb-pad)");
    }
  });
});

/**
 * The two width expressions the table has.
 *
 * The engineer's table leads with a machine's name as well as an hour, so the windows it is
 * drawn in are that much wider - one expression each, and both of them are arithmetic over the
 * same declarations. A second copy of the sum is exactly the drift this file exists to catch,
 * so both are evaluated below rather than one being taken on trust.
 */
function widthRules(): [string, string][] {
  const found = rules().filter(
    ([, body]) => /(^|[;{\s])max-width\s*:/.test(body) && body.includes("--lb-cols"),
  );
  expect(found, "max-width --lb-cols").toHaveLength(2);
  return found as [string, string][];
}

/** The one of the two that leads with a machine's name, or does not. */
function widthRule(withUnit: boolean): [string, string] {
  const found = widthRules().filter(([, b]) => b.includes("--lb-unit") === withUnit);
  expect(
    found,
    withUnit
      ? "one of the two width rules adds the machine's lane"
      : "one of the two width rules is the column table's",
  ).toHaveLength(1);
  return found[0] as [string, string];
}

const [blockSelector, blockBody] = widthRule(false);
const [unitSelector, unitBody] = widthRule(true);
const expressionOf = (body: string): string =>
  (/max-width:\s*([\s\S]*?);/.exec(body) as RegExpExecArray)[1] as string;
const expression = expressionOf(blockBody);

/**
 * What that expression comes to, in px, for a table with this many data lanes.
 *
 * The arithmetic is evaluated rather than matched as text, so the assertion is about the width
 * a browser will compute and not about how the rule happens to be typed. What is evaluated is
 * this repo's own stylesheet, read from the file beside this one.
 */
function widthOf(lanes: number, expr: string = expression): number {
  const arithmetic = expr
    .replace(/var\(--lb-cols(?:,[^)]*)?\)/g, String(lanes))
    .replace(/var\((--[a-z-]+)\)/g, (_, name: string) => String(declared(name.slice(2))))
    .replace(/px/g, "")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmax\(/g, "Math.max(");
  return Number(new Function(`return ${arithmetic}`)());
}

/** The ceiling on a data lane, which is the one measurement the sheet keeps to itself. */
const LANE = declared("lb-lane");
const TIME_LANE = declared("lb-tm");
const GAP = declared("lb-gap");
const SIDES = declared("lb-pad") * 2;

/**
 * The two windows the page is drawn in are the same width, and it is the width their lanes add
 * up to. That clamp is what keeps the page from drawing to the panel's edge over lanes that are
 * not there: measured at 1920, a rule once ran under every row for 154px past the last lane with
 * nine columns on and 482px past it with seven, and the count in the band sat out there on its
 * own. Ruled emptiness reads as columns that failed to arrive; a margin reads as a margin.
 *
 * The bar of controls is held to it too, and for a reason that is about reading rather than
 * about rules: a bar wider than the table beneath it reads as belonging to the page instead of
 * to that table, and the window it names is the table's. The panels the bar opens - the column
 * picker and the export window - are held to the same edge, so opening one does not move the
 * page's left margin.
 */
describe("the windows the logbook is drawn in", () => {
  it("clamps the bar, the panels it opens and the table's frame together", () => {
    expect(blockSelector).toBe(".swiss .lb-ctrl, .swiss .lb-pick, .swiss .lb-frame");
  });

  it("is exactly as wide as the lanes it holds", () => {
    // 1566px with nine columns on, which is where both windows stop at 1920. What is left of
    // the panel falls either side of them, because the page centres what it holds.
    expect(widthOf(9)).toBe(SIDES + TIME_LANE + 9 * (LANE + GAP));
    expect(widthOf(9)).toBe(1566);
    expect(widthOf(7)).toBe(SIDES + TIME_LANE + 7 * (LANE + GAP));
  });

  /**
   * The day a boat logged nothing earns no data columns at all, and the page still draws a
   * head and a band over the empty message. Clamped to the time column alone the band would be
   * 90px wide and would spill the date it carries, so the block never goes below one lane.
   */
  it("keeps a lane's width for the day there is nothing to show", () => {
    expect(widthOf(0)).toBe(SIDES + TIME_LANE + (LANE + GAP));
  });

  /**
   * The engineer's windows are the same sum with the machine's lane in it. Written out rather
   * than derived from the one above, so this is where the two are held together: a table whose
   * frame is short by that lane clips the last reading on every line.
   */
  it("adds the machine's lane to the windows the engineer's table is drawn in", () => {
    expect(unitSelector).toBe(
      ".swiss .lb-ctrl.u, .swiss .lb-pick.u, .swiss .lb-open.u, .swiss .lb-frame.u",
    );
    const UNIT = declared("lb-unit");
    const unit = (lanes: number) => widthOf(lanes, expressionOf(unitBody));
    expect(unit(12)).toBe(SIDES + TIME_LANE + UNIT + GAP + 12 * (LANE + GAP));
    expect(unit(4)).toBe(SIDES + TIME_LANE + UNIT + GAP + 4 * (LANE + GAP));
    // Exactly the machine's lane wider than the table without one, at every lane count.
    expect(unit(12) - widthOf(12)).toBe(UNIT + GAP);
  });
});

/**
 * The voyage record's column, and the page it is printed on.
 *
 * A passage row pins its distance to the row's right edge, so a window twice as wide puts the
 * two halves of one row twice as far apart: measured with a season of passages behind it, the
 * date and the figure sat 1111px apart on a laptop and 1575px on a desk. A row is a line
 * rather than a grid, so it cannot use that width the way the board or the log table can, and
 * it is given a measure instead. The measure is the one the same record has on paper, so that
 * the Print button produces the document that was on the screen.
 *
 * That makes two figures which have to agree: the page margin the print rules set, and the
 * measure the screen holds. This is what keeps them in step. A4 is 210mm.
 */
describe("the measure the voyage record is set to", () => {
  const A4_MM = 210;

  /** The @page rule lives inside the print block, which the rule parser above cannot reach. */
  const pageMargin = (): number => {
    const m = /@page\s*\{\s*margin:\s*([\d.]+)mm/.exec(css);
    expect(m, "@page declares a margin in mm").not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };

  const measure = (): number => {
    const [, body] = ruleDeclaring("--vy-measure");
    const m = /--vy-measure:\s*([\d.]+)mm/.exec(body);
    expect(m, "--vy-measure is declared in mm").not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };

  it("is the width of the column this record prints in", () => {
    expect(measure()).toBe(A4_MM - 2 * pageMargin());
    expect(measure()).toBe(186);
  });

  it("holds every part of the screen to it, not only the list", () => {
    // Capping the rows alone would leave the banner and the cards running to the panel's edge
    // over a list that stops, which is the ragged half-width the log table had.
    const [, body] = ruleDeclaring("max-width", "--vy-measure");
    expect(body).toContain("var(--vy-measure)");
    expect(rules().some(([s]) => s === ".swiss .vy > *")).toBe(true);
  });
});

/**
 * The bar of controls over the logbook table, which has to be the same bar whichever mode drew
 * it.
 *
 * Three things were measured wrong there, and each of them is a rule below. The bar is centred,
 * so its contents decide where its contents sit: the interval chips come to 179px and the date
 * group to 266px, and swapping one for the other slid the mode segment 38px left, the two
 * buttons on its right 38px the other way, and dropped the table 4px with the bar's own height.
 * "Now" was drawn in the 28px square meant for "<" and spilled its own border. And the bar
 * carried three type sizes - the chips at 9.5px, the date field at 12px, its arrows at 13px -
 * which is three things the eye has to take as one row of controls.
 *
 * What is pinned here is that the answers stay written once. The geometry itself is measured in
 * a browser (dev/verify/logbook_bar.py), because a stylesheet read as text cannot say where a
 * button landed.
 */
describe("the logbook's bar of controls", () => {
  /** The rules that dress something standing in that bar. */
  const CONTROLS = [
    ".swiss .seg button",
    ".swiss .lb-colbtn",
    ".swiss .lb-date button",
    ".swiss .lb-date .dt",
  ];
  /** The first rule with this selector, which is the base one: the overrides come after it. */
  const bodyOf = (selector: string): string => {
    const found = rules().find(([s]) => s === selector);
    expect(found, selector).toBeDefined();
    return (found as [string, string])[1];
  };
  const allOf = (selector: string): string[] =>
    rules().filter(([s]) => s === selector).map(([, body]) => body);

  /**
   * On the bar, and only ever on the bar. A phone steps all three down a size, which is a
   * second declaration of each - but of the row's own figures, not of any one control's. The
   * moment a control starts carrying its own, the row stops being one row.
   */
  it("declares the bar's type, height and inset on the bar, wherever it declares them", () => {
    for (const token of ["--lb-ctrl-fs", "--lb-ctrl-h", "--lb-ctrl-pad"]) {
      const where = rules()
        .filter(([, body]) => new RegExp(`(^|[;{\\s])${token}\\s*:`).test(body))
        .map(([sel]) => sel);
      expect(where.length, `${token} is declared somewhere`).toBeGreaterThan(0);
      expect(new Set(where), token).toEqual(new Set([".swiss .lb-ctrl"]));
    }
  });

  /**
   * What a phone does differently, and the shape of it: it steps the row's figures, and it
   * takes away one control. Measured, the type step alone is worth six pixels of bar - the
   * height is set by how many rows the group wraps into, and the date group is what decides
   * that. Without the two day arrows it fits beside the mode segment and a whole row goes:
   * 138px to 93 on the bridge book, 179 to 132 on the engineer's. Neither does it alone.
   */
  it("steps the row down on a phone, and drops the day arrows there", () => {
    const stepped = rules().filter(
      ([sel, body]) => sel === ".swiss .lb-ctrl" && /--lb-ctrl-fs/.test(body),
    );
    expect(stepped.length, "a base size and a phone's").toBe(2);
    const sizes = stepped.map(([, b]) => Number(/--lb-ctrl-fs:\s*([\d.]+)px/.exec(b)?.[1]));
    expect(sizes[1], "the phone's is the smaller").toBeLessThan(sizes[0] as number);
    expect(bodyOf(".swiss .lb-date .lb-step")).toContain("display: none");
  });

  it("sets no control's type, height or inset in figures of its own", () => {
    for (const selector of CONTROLS) {
      const body = bodyOf(selector);
      expect(body, `${selector} font-size`).not.toMatch(/font-size:\s*[\d.]+px/);
      expect(body, `${selector} height`).not.toMatch(/[;{\s]height:\s*[\d.]+px/);
      expect(body, `${selector} reads the bar's type`).toContain("--lb-ctrl-fs");
      expect(body, `${selector} reads the bar's inset`).toContain("--lb-ctrl-pad");
    }
  });

  /**
   * The one control in the bar that is an input, and the floor it does not share with the rest.
   *
   * iOS Safari zooms the page when a field under 16px takes focus, the layout viewport grows
   * past the visual one and the app pans sideways. This sheet already learned that once, on the
   * form fields, and says so over `.field textarea`; the date picker reached the same trap from
   * the other direction, by taking a row of buttons' type. So the rule above is deliberately
   * NOT the whole story for this one selector, and the assertion is that the exception exists
   * rather than that it does not.
   */
  it("keeps the date field off the floor iOS zooms below", () => {
    const bodies = allOf(".swiss .lb-date .dt");
    expect(bodies.length, "a base rule and a narrow-screen override").toBe(2);
    const sizes = bodies
      .map((b) => /font-size:\s*([\d.]+)px/.exec(b))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(sizes, "the override states a figure, and it is the floor").toEqual([16]);
  });

  /** The group carries the bar's height so that its own border does not stand outside it. */
  it("gives the segmented groups the height and their buttons the whole of it", () => {
    expect(bodyOf(".swiss .seg")).toContain("height: var(--lb-ctrl-h, 32px)");
    expect(bodyOf(".swiss .seg")).toContain("box-sizing: border-box");
    expect(bodyOf(".swiss .seg button")).toContain("height: 100%");
  });

  /** A floor, never a fixed width: the arrows are square and the word is not. */
  it("lets the date group's word take the room it needs", () => {
    const body = bodyOf(".swiss .lb-date button");
    expect(body).toContain("min-width: var(--lb-ctrl-h, 32px)");
    expect(body, "a fixed width is what clipped Now").not.toMatch(/[;{\s]width:\s*[\d.]+px/);
  });

  /**
   * The window slot's floor, which is what keeps the bar from re-centring on whichever mode is
   * up. It is a floor and not a width - a long range label still grows past it - and it gives
   * way at 100%, because on a phone the floor is wider than the room beside the mode segment
   * and a hard minimum there would push the bar off the edge instead of wrapping it.
   */
  it("holds the window slot to a floor that gives way on a narrow screen", () => {
    const body = bodyOf(".swiss .lb-win");
    expect(body).toMatch(/min-width:\s*min\([\d.]+px,\s*100%\)/);
    expect(body, "it leaves on the table's clock").toContain("var(--lb-fade-in)");
    expect(bodyOf(".swiss .lb-win.leaving")).toContain("var(--lb-fade-out)");
  });

  /**
   * The other berth, and the reason it is only half a berth. What the columns button says
   * depends on the screen it is read on and on what the window holds - "Columns · 12",
   * "Columns · 3 of 12", "Columns · 0" - and on a phone the widest and the narrowest of those
   * are 39px apart, which in a centred bar is the row shuffling 20px each way. On a desk the
   * same two states are 4px apart, and the count's own berth below covers that; a floor there
   * would have to reserve the phone's width over a desk's pair and leave 50px of nothing in the
   * middle of the row. So the floor is declared where it is earned and not in the base rule.
   */
  it("closes the panel buttons up to the bar's edge, and floors them only on a phone", () => {
    const body = bodyOf(".swiss .lb-acts");
    expect(body).toContain("justify-content: flex-end");
    expect(body, "no floor on a desk").not.toMatch(/min-width/);
    const floored = allOf(".swiss .lb-acts").filter((b) => /min-width/.test(b));
    expect(floored, "one floor, in the narrow-screen block").toHaveLength(1);
    expect(floored[0]).toMatch(/min-width:\s*min\([\d.]+px,\s*100%\)/);
  });

  /**
   * Inside the button, the same idea one size down: a figure keeps its room across ten.
   *
   * Not 2ch, though that is what the unit's name suggests. `ch` is the advance of a bare figure
   * and this bar tracks its type out, so two figures drawn come to 17.1px where 2ch reserves
   * 13px - and the button went on breathing 4px. The berth is what was measured on the screen.
   */
  it("gives the count a berth of its own, sized to what is drawn", () => {
    const body = bodyOf(".swiss .lb-colbtn b");
    const m = /min-width:\s*([\d.]+)ch/.exec(body);
    expect(m, "a berth in ch, so it follows the type").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBeGreaterThan(2);
    expect(body).toContain("tabular-nums");
  });
});

/**
 * The barometer cell gives its width to the trend line.
 *
 * It is the one cell on the bridge that draws a reading and a chart together, and it used to do
 * it in two columns: figure left, line and caption right. Measured at four widths, that left the
 * line 54px where the gust cell beside it - the same size, the same kind of chart - gave its own
 * 141px. Three hours of pressure drawn in a third of the room is the thing the cell is for.
 *
 * Two rules carry that and neither is visible to a test that renders markup, so they are held
 * here. A ceiling on the line is the second half: the line took `max-width: 220px` when it sat
 * in a column of its own, and left in place it would cap the width this change went and got.
 */
describe("the barometer cell's layout", () => {
  const rule = (selector: string): string => {
    const found = rules().find(([s]) => s === selector);
    expect(found, selector).toBeDefined();
    return (found as [string, string])[1];
  };

  it("runs down the cell rather than across it", () => {
    expect(rule(".swiss .c-baro")).toMatch(/flex-direction:\s*column/);
  });

  it("puts no ceiling on the trend line, so it is the cell's width", () => {
    const body = rule(".swiss .spark-b");
    expect(body).toMatch(/width:\s*100%/);
    expect(body, "a ceiling here undoes the width the cell just gave it").not.toMatch(/max-width/);
  });
});

/**
 * The two cards at the logbook door.
 *
 * They are stretched to a common height and stand side by side, so the eye reads across them.
 * What they hold is two sentences of different lengths - the deck book's runs to three lines,
 * the engine book's to two - and the verb under them was spaced off the sentence with a fixed
 * margin, which put the two verbs 21.6px apart. The one thing both cards say in the same words
 * was the one thing out of line. The sheet's own comment said the verb was "kept to the foot of
 * the card"; a comment that states a condition is a test, and this is it.
 */
describe("the logbook door's cards", () => {
  it("keeps the verb at the foot, so both cards say it at the same height", () => {
    const found = rules().find(([s]) => s === ".swiss .lbd-go");
    expect(found, ".swiss .lbd-go").toBeDefined();
    const body = (found as [string, string])[1];
    expect(body, "a figure here follows the sentence above it, not the card").toMatch(
      /margin-top:\s*auto/,
    );
  });
});
