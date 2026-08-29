/**
 * The voyage page is clusters under heading bands, and the bands must answer for what
 * their sheets actually show. Both defects the first review of this composition found
 * lived exactly here: a count badge over an error sentence, and a pulse fed by no
 * freshness field at all. The real screen over a stubbed data hook, read as markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Voyage } from "../../lib/api";
import type { VoyageData } from "./useVoyageData";

let data: VoyageData;

vi.mock("./useVoyageData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useVoyageData")>()),
  useVoyageData: () => data,
}));

beforeAll(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
});

function voyage(over: Partial<Voyage> = {}): Voyage {
  return {
    id: 1,
    start_ts: 1_770_000_000_000,
    end_ts: 1_770_040_000_000,
    distance_nm: 42.3,
    hours_underway: 6.5,
    avg_sog_kn: 6.5,
    max_sog_kn: 8.1,
    ...over,
  } as Voyage;
}

async function draw(over: Partial<VoyageData>): Promise<string> {
  data = {
    current: null,
    currentStale: false,
    currentSeenTs: null,
    stats: null,
    list: [],
    loading: false,
    err: null,
    ...over,
  };
  const { default: VoyageMarine } = await import("./VoyageMarine");
  return renderToStaticMarkup(<VoyageMarine />);
}

describe("the bands answer for their sheets", () => {
  it("counts the voyages only while the sheet is showing them", async () => {
    const three = await draw({ list: [voyage({ id: 1 }), voyage({ id: 2 }), voyage({ id: 3 })] });
    expect(three).toMatch(/sp-sec-badge[^<]*>3</);

    // The trap: a failed reload keeps the previous list in state, and the sheet prints the
    // error sentence - the badge must not keep saying 3 over it.
    const stale = await draw({
      list: [voyage({ id: 1 }), voyage({ id: 2 }), voyage({ id: 3 })],
      err: "She did not answer in time",
    });
    expect(stale).toContain("She did not answer in time");
    expect(stale).toMatch(/sp-sec-badge quiet[^<]*>unreachable/);
    expect(stale).not.toMatch(/sp-sec-badge[^<]*>3</);
  });

  it("opens without a count until the first load lands", async () => {
    const html = await draw({ loading: true });
    expect(html).toContain("Voyages");
    expect(html).not.toMatch(/sp-sec-badge[^<q]*>\d/);
  });

  it("says shown, not all, when the list hits the fetch cap", async () => {
    const html = await draw({ list: Array.from({ length: 50 }, (_, i) => voyage({ id: i + 1 })) });
    expect(html).toMatch(/50 shown/);
  });

  it("beats the pulse only while the boat is actually being heard", async () => {
    const underway = voyage({ id: 9, end_ts: null as unknown as number });
    const fresh = await draw({ current: underway });
    expect(fresh).toContain("vy-pulse");
    expect(fresh).toContain("Under way");

    // The link died: `current` is the last answer, not the present. The lamp goes out and
    // the badge says how old the answer is, in red.
    const stale = await draw({
      current: underway,
      currentStale: true,
      currentSeenTs: Date.now() - 14 * 60_000,
    });
    expect(stale).not.toContain("vy-pulse");
    expect(stale).toMatch(/sp-sec-badge quiet[^<]*>since .* last seen 14 min ago/);
  });

  it("marks the totals unreachable when their load failed", async () => {
    const html = await draw({ err: "Could not load voyage data" });
    expect(html).toContain("Totals");
    expect(html).toMatch(/Totals<\/span>[\s\S]{0,200}?sp-sec-badge quiet[^<]*>unreachable/);
  });

  it("draws no bare actions strip over an empty book", async () => {
    const html = await draw({});
    expect(html).not.toContain("vy-hd");
    expect(html).toContain("No voyages yet");
  });
});
