import { useEffect } from "react";
import { api } from "../lib/api";

/**
 * AuthGate - Signal K security is enabled and the plugin REST call returned
 * 401. Instead of an empty-dashboard surprise, show a single clear screen:
 * redirect to Signal K's own login, probe access in the background, and reload
 * for a clean boot once it opens up. No password passes through here - identity
 * is handled entirely by Signal K.
 *
 * Note (signalk-server 2.27): with security enabled, /plugins/* requires admin
 * privileges - a read-only account and anonymous read are not enough; that is
 * why the footnote exists.
 */
const PROBE_MS = 3000;

export default function AuthGate() {
  useEffect(() => {
    let inFlight = false;
    const id = setInterval(async () => {
      // Login is most likely done in another tab; don't probe while this tab
      // is hidden - it will be caught on the first tick after returning.
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        await api.live();
        window.location.reload();
      } catch {
        inFlight = false;
      }
    }, PROBE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="sp-auth" role="alert">
      <span className="sp-auth-mk">
        Siparu
      </span>
      <div className="sp-auth-card">
        <span className="sp-auth-kick">Sign-in required</span>
        <p className="sp-auth-body">
          This Signal K server only shares boat data with signed-in users.
          Siparu reads everything through Signal K, so sign in there and
          come back - the dashboard picks up on its own.
        </p>
        <a className="sp-auth-cta" href="/admin/#/login" target="_blank" rel="noopener">
          Open Signal K sign-in
        </a>
        <p className="sp-auth-foot">
          Signed in but still locked out? Your account may not have enough
          access - ask whoever runs this Signal K server.
        </p>
      </div>
      <span className="sp-auth-wait">
        <span className="sp-auth-pulse" aria-hidden="true" />
        Waiting for sign-in
      </span>
    </div>
  );
}
