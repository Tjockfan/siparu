/** The on-board shell: the shared Swiss layout with the bridge tabs at the root of the app.
 *  The heavy sibling chunks are warmed here because only this app knows where its chunks are. */
import { Layout } from "siparu-ui/shell";

const WARM = [
  () => import("../routes/Logbook"),
  () => import("../routes/Voyage"),
  () => import("../routes/Map"),
  () => import("../routes/Remote"),
];

export default function BridgeLayout() {
  return <Layout warm={WARM} />;
}
