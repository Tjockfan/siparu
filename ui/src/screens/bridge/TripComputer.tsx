/**
 * The passage she is on, beside the instruments that are making it.
 *
 * Asked for by an owner, and the reason is worth keeping: the voyage figures
 * already existed but only after a passage had closed, on another screen. What
 * they wanted was to read the average against the instantaneous while under
 * way, so that the current burn means something. That is why this sits on the
 * bridge board rather than on the Voyage screen.
 *
 * It draws whatever `tripReadings` hands it and owns no list of cells, the same
 * rule the bridge and the system panels follow: a boat whose engines report no
 * fuel rate simply has fewer cells here, and nothing has to know she is that
 * kind of boat. The panel itself disappears when she is not on a passage,
 * because there is no trip to compute and an empty frame reads as a fault.
 */
import type { Voyage } from "../../data/api";
import { tripReadings } from "../../lib/trip";

export default function TripComputer({ voyage, now }: { voyage: Voyage | null; now: number }) {
  if (voyage === null) return null;
  const readings = tripReadings(voyage, now);
  if (readings.length === 0) return null;

  return (
    <div className="grid">
      <div className="matrix">
        {readings.map((r) => (
          <div className="c" key={r.key}>
            <div className="t">
              {r.label} · <span className="sub">{r.sub}</span>
            </div>
            <div className="n">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
