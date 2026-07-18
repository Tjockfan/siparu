/* Pairing - the boat's half, on the Bridge screen.
 *
 * Deliberately not a tab. Pairing happens once in a vessel's life; a tab for it
 * would sit there dead for the rest of that life, in the way. So it lives under the
 * grid and takes up room only when it has something to say - a code to show, or a
 * stranger to refuse.
 *
 * The approval state is the one that matters and it gets the loudest treatment on
 * the panel. Anyone can photograph a code off a screen at a boat show or through an
 * open saloon door; nobody can tap Approve without standing at this screen. That tap
 * is the whole security model, so it is not allowed to look like a notification.
 */
import { useEffect, useState } from "react";
import { api, type PairScreen, type UplinkStatus } from "../../lib/api";
import { ageOf } from "../../lib/age";
import { usePolling } from "../../lib/usePolling";

const PORTAL = "app.siparu.app";

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

/**
 * Spelled out rather than abbreviated: this one lands inside a sentence a person reads
 * once, at the helm, to find out whether the link is working.
 *
 * What this line can actually say is bounded by the cadence it reads, which is worth
 * knowing before reading anything into a number here. The timestamp is refreshed every
 * two seconds while the socket is up and every sixty by the POST that stands in when it
 * is not, and a refresh that fails takes uplinkLine to a different branch entirely. So
 * this counts seconds and the first minute or so, and the tiers above that are the
 * ladder's, not this screen's.
 *
 * The first minute is the part that had to be right and was not: this used to round, so
 * it printed "89s ago" and then jumped to "2 min ago" without ever saying one. Against a
 * sixty second interval that made the minute tier meaningless - "2 min" arrived while she
 * was still on schedule - where now "1 min" is a little late and "2 min" is a frame she
 * missed.
 */
function ago(ts: number): string {
  const { value, unit } = ageOf((Date.now() - ts) / 1000);
  return `${value}${unit === "s" ? "s" : ` ${unit}`} ago`;
}

/**
 * "On" is not the same as "getting through", and the gap between them is the quietest
 * way this product can fail: the boat says she is paired, the owner ashore watches a
 * screen that has not moved since Tuesday, and nobody is told why. So the boat says
 * whether her frames are landing, in the same breath as saying she is linked.
 */
function uplinkLine(up: UplinkStatus | undefined): string {
  if (!up) return "Checking the link…";
  if (up.rejected || up.failures > 0) return up.lastError ?? "Not reaching Siparu.";
  if (up.lastSentTs) return `Sending · last frame ${ago(up.lastSentTs)}`;
  return "Waiting to send the first frame.";
}

export default function PairBand() {
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  // A code on screen means the relay is being polled every 5s. A paired boat means
  // nothing changes for months - poll it like it.
  const { data, refresh } = usePolling<PairScreen>(() => api.pair.status(), fast ? 5_000 : 30_000, []);

  useEffect(() => {
    const s = data?.state;
    setFast(s === "showing_code" || s === "awaiting_approval");
  }, [data?.state]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch {
      // The plugin remembers why it failed and /pair/status reports it on the next
      // tick. Inventing a second error message here would only compete with the
      // real one.
    } finally {
      setBusy(false);
      setConfirmOff(false);
      refresh();
    }
  }

  // Nothing until the first status lands: a band that appears and then changes shape
  // would shove the grid around on every boot.
  if (!data) return null;

  const btn = (label: string, onClick: () => void, tone?: "accent" | "ghost") => (
    <button className={`pbtn${tone ? ` ${tone}` : ""}`} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );

  // The warning stands above whatever the band shows, in every state: it is about the
  // server's door, not about where in the pairing flow she happens to be. It does not
  // block anything - refusing to pair would stop the owner and not the intruder, who
  // has shorter ways into an unsecured server.
  const warning = data.security_off ? (
    <div className="pair warn">
      <div className="pl">
        <div className="t">Signal K security is off</div>
        <div className="s">
          Anyone who can reach this network can link this boat to their account, and this
          screen would still say she is yours. Add an admin user in Signal K, then pair.
        </div>
      </div>
    </div>
  ) : null;

  // "Off on this boat, still revoking ashore" is a different truth from plain "off".
  // The plugin retries by itself; this only keeps the screen from flattening it.
  const revoking = data.revoke_pending ? (
    <div className="pair warn">
      <div className="pl">
        <div className="t">Still revoking the old key</div>
        <div className="s">
          Remote viewing is off on this boat, but Siparu could not be reached to revoke
          its copy of the key. It will keep trying whenever the boat is online.
        </div>
      </div>
    </div>
  ) : null;

  const band = (() => {
    switch (data.state) {
        case "idle":
      case "expired":
        return (
          <div className="pair">
            <div className="pl">
              <div className="t">Remote viewing</div>
              <div className="s">
                {data.state === "expired"
                  ? "The code expired. Nothing was linked."
                  : "Off - this boat is not linked to an account."}
              </div>
            </div>
            {btn(data.state === "expired" ? "New code" : "Turn on", () => act(api.pair.start))}
          </div>
        );

      case "showing_code":
        return (
          <div className="pair">
            <div className="pl">
              <div className="t">Remote viewing · waiting</div>
              <div className="code">{data.userCode}</div>
              <div className="s">
                Enter this at <b>{PORTAL}</b> · {minutesLeft(data.expiresAt)} min left
              </div>
            </div>
            {btn("Cancel", () => act(api.pair.deny), "ghost")}
          </div>
        );

      case "awaiting_approval":
        return (
          <div className="pair asking">
            <div className="pl">
              <div className="t">Someone wants to pair</div>
              <div className="who">{data.email ?? "an account we cannot name"}</div>
              <div className="s">Approve only if this is you. They will see where this boat is.</div>
            </div>
            <div className="acts">
              {btn("Deny", () => act(api.pair.deny), "ghost")}
              {btn("Approve", () => act(api.pair.approve), "accent")}
            </div>
          </div>
        );

      case "paired":
        return (
          // A rejected token is not a state to report calmly: the owner is watching a
          // dead screen and only someone standing here can fix it.
          <div className={`pair${data.uplink?.rejected ? " err" : ""}`}>
            <div className="pl">
              <div className="t">Remote viewing · on</div>
              <div className="who">{data.email ?? "linked account"}</div>
              {!confirmOff && <div className="s">{uplinkLine(data.uplink)}</div>}
            </div>
            {confirmOff ? (
              <div className="acts">
                {btn("Keep", () => setConfirmOff(false), "ghost")}
                {btn("Unlink", () => act(api.pair.reset), "accent")}
              </div>
            ) : (
              <div className="acts">
                {/* Without this button the only way back to a fresh code was Turn off,
                    and unlinking throws away the token that proves she is this boat -
                    which is exactly how an owner ends up with duplicates of her own
                    vessel. Pairing again keeps the proof, so she stays one boat. */}
                {btn("Pair again", () => act(api.pair.start), "ghost")}
                {/* Two taps, because this is the one that matters when a boat changes
                    hands: it destroys the token and the previous owner stops seeing her. */}
                {btn("Turn off", () => setConfirmOff(true), "ghost")}
              </div>
            )}
          </div>
        );

      case "error":
        return (
          <div className="pair err">
            <div className="pl">
              <div className="t">Remote viewing · error</div>
              <div className="s">{data.message}</div>
            </div>
            <div className="acts">
              {btn("Dismiss", () => act(api.pair.reset), "ghost")}
              {btn("Retry", () => act(api.pair.start))}
            </div>
          </div>
        );
    }
  })();

  return (
    <>
      {warning}
      {revoking}
      {band}
    </>
  );
}
