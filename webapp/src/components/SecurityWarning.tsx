/**
 * The server's door is open.
 *
 * Shown in two places on purpose, which is worth stating because a warning printed twice
 * usually means nobody decided where it belonged. On the instruments it is the first thing on
 * the screen an owner looks at all day, so the condition cannot go unnoticed. On the remote
 * page it is the reason the buttons beside it are missing: with the door open and unanswered
 * for, the plugin refuses pairing writes, and a page that hid the controls without saying why
 * would read as a fault in the product.
 *
 * Not an error and not an event. A standing condition somebody has to go and fix, marked down
 * the edge and left there until it is.
 */
export default function SecurityWarning({
  on,
  locked,
}: {
  on: boolean | undefined;
  /** Writes are refused as well as unguarded, which changes what there is to say. */
  locked: boolean;
}) {
  if (!on) return null;
  return (
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
  );
}
