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
import { api, type PairScreen } from "../../lib/api";
import { usePolling } from "../../lib/usePolling";

const PORTAL = "app.siparu.app";

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
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
        <div className="pair">
          <div className="pl">
            <div className="t">Remote viewing · on</div>
            <div className="who">{data.email ?? "linked account"}</div>
            {!confirmOff && <div className="s">Reinstalled, or on a new plotter? Pair again.</div>}
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
}
