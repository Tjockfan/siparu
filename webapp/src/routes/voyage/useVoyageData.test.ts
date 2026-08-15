import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { voyageLoadError } from "./useVoyageData";

/** The banner over the voyage list, when the load failed.
 *
 * It is the one place on this screen that shows a sentence nobody wrote, so what it refuses
 * to show matters as much as what it does.
 */
describe("voyageLoadError", () => {
  it("shows the plugin's own sentence and not the status code it arrives with", () => {
    const e = new ApiError(503, "She is restarting after a settings change");
    expect(e.message).toContain("503");
    expect(voyageLoadError(e)).toBe("She is restarting after a settings change");
  });

  it("falls back when the server answered with a status and nothing to say", () => {
    expect(voyageLoadError(new ApiError(500, ""))).toBe("Could not load voyage data");
  });

  it("names a timeout, because the runtime's word for it is not one", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(voyageLoadError(timeout)).toBe("She did not answer in time");
  });

  it("never puts a raw Error message in front of the helm", () => {
    // The failure this replaced: a TypeError from the fetch layer went on the banner verbatim.
    expect(voyageLoadError(new TypeError("NetworkError when attempting to fetch resource."))).toBe(
      "Could not load voyage data",
    );
    expect(voyageLoadError("something thrown that is not an Error")).toBe(
      "Could not load voyage data",
    );
  });
});
