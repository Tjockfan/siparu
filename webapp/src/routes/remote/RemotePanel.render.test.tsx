/**
 * The remote page is two clusters in the dashboard's dress: the link ashore and the screens
 * she seals to, each under a heading band whose badge answers for the whole cluster. The
 * pairing states cannot be produced on a live bench (the demo boat's pairing is locked), so
 * the composition is pinned here: the real panel over a stubbed poll, read as markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PairScreen, SealingStatus } from "../../lib/api";

let status: PairScreen | null = null;

// Only the fetching is stood in for, per the mock rule this suite keeps: the panel, the
// sections and the badge logic under test are all the real module.
vi.mock("../../lib/usePolling", () => ({
  usePolling: () => ({ data: status, refresh: () => {}, error: null, loading: false }),
}));

async function draw(s: PairScreen | null, sealing: SealingStatus | null = null): Promise<string> {
  status = s;
  const { default: RemotePanel } = await import("./RemotePanel");
  return renderToStaticMarkup(<RemotePanel sealing={sealing} />);
}

const paired: PairScreen = {
  state: "paired",
  boatId: "boat-0001",
  email: "owner@example.com",
  pairedAt: "2026-08-01T00:00:00Z",
  uplink: { lastSentTs: Date.now() - 4_000, failures: 0, rejected: false, lastError: null },
};

describe("the two clusters", () => {
  it("dresses the link as a cluster and answers for it in the badge", async () => {
    const html = await draw(paired);
    expect(html).toContain("sp-sec-h");
    expect(html).toContain("Link ashore");
    // The state lives in the badge once, not in the badge and the cell title both.
    expect(html).toContain("rm-dot");
    expect(html).toMatch(/sp-sec-badge[^<]*>.*on</);
    expect(html).not.toContain("Remote viewing · on");
    expect(html).toContain("owner@example.com");
  });

  /**
   * The badge reads the same fields the cell's sentence reads. The first review of this page
   * caught it reading fewer: a pulsing ON over "Not reaching Siparu.", which is the quiet
   * failure the file's own header warns about, promoted to a lamp.
   */
  it("never shines ON over a link that is not getting through", async () => {
    const failing = await draw({
      ...paired,
      uplink: { lastSentTs: Date.now() - 900_000, failures: 7, rejected: false, lastError: null },
    });
    expect(failing).toMatch(/sp-sec-badge quiet[^<]*>.*not reaching/);
    expect(failing).not.toContain("rm-dot");

    // Linked with no frame out yet: on, and the pulse waits for the first frame to land.
    const firstFrame = await draw({
      ...paired,
      uplink: { lastSentTs: null, failures: 0, rejected: false, lastError: null },
    });
    expect(firstFrame).toMatch(/sp-sec-badge[^<]*>on</);
    expect(firstFrame).not.toContain("rm-dot");

    const inactive = await draw({
      ...paired,
      uplink: { lastSentTs: null, failures: 0, rejected: false, lastError: null, unentitled: true },
    });
    expect(inactive).toMatch(/sp-sec-badge[^<]*>inactive/);
    expect(inactive).not.toMatch(/sp-sec-badge quiet/);
  });

  it("opens without a badge until the first status lands, rather than saying CHECKING twice", async () => {
    const html = await draw(null);
    expect(html).toContain("Link ashore");
    expect(html).not.toContain("sp-sec-badge");
    expect(html).toContain("Checking the link…");
  });

  it("keeps red for the states that want a person at this screen", async () => {
    const asking = await draw({
      state: "awaiting_approval",
      userCode: "ABCD-1234",
      email: "owner@example.com",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(asking).toMatch(/sp-sec-badge quiet[^<]*>.*asking/);

    const err = await draw({ state: "error", message: "the relay refused" });
    expect(err).toMatch(/sp-sec-badge quiet[^<]*>.*error/);

    const off = await draw({ state: "idle" });
    expect(off).toMatch(/sp-sec-badge[^<]*>.*off/);
    expect(off).not.toMatch(/sp-sec-badge quiet/);
  });

  it("counts the screens off the same list the sheet prints", async () => {
    const sealing: SealingStatus = {
      mode: "sealed",
      reason: null,
      screens: ["T3HB-AH37-8SXB-NQR0", "T4E8-5VKQ-YJ7H-G04X"],
    } as SealingStatus;
    const html = await draw(paired, sealing);
    expect(html).toContain("Screens");
    expect(html).toMatch(/2 sealed/);
    expect(html).toContain("T3HB-AH37-8SXB-NQR0");
  });

  it("draws no screens cluster over a boat with nothing to list", async () => {
    const html = await draw(paired, null);
    // One heading band on the page, and it is the link's.
    expect(html.match(/sp-sec-h/g)).toHaveLength(1);
  });
});
