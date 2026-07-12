/** Map screen - single surface. The MapLibre engine lives in map/useMapEngine.ts.
 *  The legacy theme dispatcher has been removed (DESIGN-SYSTEM.md Phase 5). */
import MapMarine from "./map/MapMarine";

export default function Map() {
  return <MapMarine />;
}
