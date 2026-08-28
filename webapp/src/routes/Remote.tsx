/** Remote screen - the boat's link ashore: the account she is paired with, the codes that
 *  pair her, and the screens she seals to. Everything on it lives in remote/RemotePanel;
 *  the sealing status comes from the same health poll the instruments read. */
import RemotePanel from "./remote/RemotePanel";
import { api, type HealthResult } from "../lib/api";
import { usePolling } from "../lib/usePolling";

// Slower than the bridge reads it: nothing on this page changes between one glance and the
// next, and the page it shares the answer with is polling anyway.
const POLL_MS = 30_000;

export default function Remote() {
  const { data } = usePolling<HealthResult>(api.health, POLL_MS, []);
  return (
    <div className="sp-remote">
      <RemotePanel sealing={data?.sealing ?? null} />
    </div>
  );
}
