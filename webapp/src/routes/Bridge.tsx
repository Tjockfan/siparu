/** Bridge screen - single surface (cockpit). Drawn by the shared screen; the data comes
 *  through the ApiProvider the app mounts (lib/api, the plugin's REST routes). */
import BridgeMarine from "siparu-ui/screens/bridge";

export default function Bridge() {
  return <BridgeMarine />;
}
