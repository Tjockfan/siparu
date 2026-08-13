/** Bridge screen - single surface (cockpit). The old theme dispatcher was
 *  removed (DESIGN-SYSTEM.md Phase 5: marine as the single base, pastel/ios
 *  retired). Data/logic lives in bridge/useBridgeData.ts. */
import BridgeMarine from "./bridge/BridgeMarine";

export default function Bridge() {
  return <BridgeMarine />;
}
