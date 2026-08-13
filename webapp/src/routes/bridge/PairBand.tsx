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
import { api, type PairScreen, type SealingStatus, type UplinkStatus } from "../../lib/api";
import { ageOf } from "../../lib/age";
import { sealingNotice } from "../../lib/sealing";
import { usePolling } from "../../lib/usePolling";

/*
 * The address a person reads off this screen and types into a phone or a laptop, so it has
 * to be the one that ends on the page with the box for this code. The portal used to have a
 * subdomain of its own; that name is retired and now redirects to the site root, which is
 * the marketing page and has nowhere to put a code. Somebody following the old line landed
 * one page short of the only thing this band is asking them to do.
 */
const PORTAL = "siparu.app/app";

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

export default function PairBand({ sealing }: { sealing?: SealingStatus | null }) {
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

  // Silence has to be reported whatever the pairing screen is doing, so it is read before
  // the guard below and rendered on its own: a boat that cannot seal to anybody is refusing
  // to send while /pair/status still calls her linked and well, which is precisely the pair
  // of facts that makes this failure invisible.
  const silent = sealingNotice(sealing);
  // Marked down the edge like the security warning rather than styled as an error, and for
  // the same reason: this is a standing condition somebody has to go and fix, not an event
  // that has just happened and can be dismissed.
  const silence = silent ? (
    <div className="pair warn">
      <div className="pl">
        <div className="t">{silent.title}</div>
        <div className="s">{silent.detail}</div>
      </div>
    </div>
  ) : null;

  /*
   * The screens she seals to, named by fingerprint.
   *
   * A device her owner adds ashore reaches her as a public key passed along by the relay, and
   * she cannot tell one that came from his phone from one the relay substituted for its own.
   * The specification names that plainly and names the antidote: a person aboard comparing this
   * list with the line his phone shows him. This screen is on the boat's own network, which is
   * what makes the comparison worth anything - it is the one exchange in the product the server
   * has no part in.
   *
   * Offered rather than demanded. Nothing here blocks or warns; an owner who never looks is in
   * the position he was in before, and one who wants to check can, without a trip through a
   * settings page he would have to be told about first.
   */
  const screens = sealing?.screens ?? [];
  const fingerprints =
    screens.length > 0 ? (
      <div className="pair">
        <div className="pl">
          <div className="t">Screens she seals to</div>
          <div className="fps">
            {screens.map((fp, i) => (
              <span className="fp" key={`${fp}-${i}`}>
                {fp}
              </span>
            ))}
          </div>
          <div className="s">
            Every screen that can open her reports has a line here. If the line on your phone is
            missing, she is not sealing to it; if a line here is not one of yours, it can read her.
          </div>
        </div>
      </div>
    ) : null;

  // Nothing until the first status lands: a band that appears and then changes shape
  // would shove the grid around on every boot. The fingerprints are not part of that shape -
  // they come from the health poll, not from this one, and a boat whose pairing status is slow
  // to arrive is still a boat whose owner may be standing here to check a key.
  if (!data)
    return (
      <>
        {silence}
        {fingerprints}
      </>
    );

  const btn = (label: string, onClick: () => void, tone?: "accent" | "ghost") => (
    <button className={`pbtn${tone ? ` ${tone}` : ""}`} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );

  // The warning stands above whatever the band shows, in every state: it is about the
  // server's door, not about where in the pairing flow she happens to be. When the
  // door is open AND unanswered-for, the plugin refuses the writes (pairing_locked),
  // and the buttons below disappear rather than fail: a locked button the screen
  // cannot explain is worse than no button.
  const locked = data.pairing_locked === true;
  const warning = data.security_off ? (
    <div className="pair warn">
      <div className="pl">
        <div className="t">
          {locked ? "Signal K security is off · pairing is locked" : "Signal K security is off"}
        </div>
        <div className="s">
          {locked
            ? "Anyone on this network could link this boat to another account or cut her " +
              "loose, so pairing, unpairing and log edits stay locked. Add an admin user " +
              "in Signal K - or, on a network you trust, accept the risk in the plugin settings."
            : "Anyone who can reach this network can link this boat to their account, and " +
              "the only sign here would be a linked account you do not recognise. Add an " +
              "admin user in Signal K."}
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
            {!locked && btn(data.state === "expired" ? "New code" : "Turn on", () => act(api.pair.start))}
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
              {!locked && btn("Approve", () => act(api.pair.approve), "accent")}
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
              {/* Silent because she cannot seal: the uplink is fine and its own line would
                  say "Sending" under a band that has just said nothing is getting through.
                  The band above is the truer of the two, so it speaks alone. */}
              {!confirmOff && !silent && <div className="s">{uplinkLine(data.uplink)}</div>}
            </div>
            {locked ? null : confirmOff ? (
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
            {!locked && (
              <div className="acts">
                {btn("Dismiss", () => act(api.pair.reset), "ghost")}
                {btn("Retry", () => act(api.pair.start))}
              </div>
            )}
          </div>
        );
    }
  })();

  return (
    <>
      {silence}
      {warning}
      {revoking}
      {band}
      {fingerprints}
    </>
  );
}
