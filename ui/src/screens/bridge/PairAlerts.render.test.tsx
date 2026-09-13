/**
 * The disk's verdict, drawn where an owner is looking.
 *
 * `recordingNotice` is a pure function with its own suite, and a pure function nobody renders
 * is exactly the shape of the dead depth diagnosis this repo once carried: green at every
 * assertion, invisible on the glass. So the band is asserted against markup, through the real
 * component, with only the pairing poll stood in for.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../data/usePolling", () => ({
  usePolling: () => ({ data: null, refresh: () => {}, error: null, loading: false }),
}));

async function draw(writes: { ok: boolean; failures: number; last_error: string | null } | null) {
  const { default: PairAlerts } = await import("./PairAlerts");
  return renderToStaticMarkup(
    <MemoryRouter>
      <PairAlerts sealing={null} writes={writes} />
    </MemoryRouter>,
  );
}

describe("the recording band", () => {
  it("is not drawn while the disk takes her rows", async () => {
    const html = await draw({ ok: true, failures: 0, last_error: null });
    expect(html).not.toContain("Not recording");
  });

  it("is not drawn for a plugin too old to have a verdict", async () => {
    expect(await draw(null)).not.toContain("Not recording");
  });

  it("names the refusal in the disk's words, as a band and not a link", async () => {
    const html = await draw({ ok: false, failures: 2, last_error: "ENOSPC: no space left on device" });
    expect(html).toContain("Not recording her history");
    expect(html).toContain("ENOSPC: no space left on device");
    // The sealing alerts open the Remote page; this one has nowhere to go.
    expect(html).not.toMatch(/<a[^>]*>[^<]*Not recording/);
  });
});
