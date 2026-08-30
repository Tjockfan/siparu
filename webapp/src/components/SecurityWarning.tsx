/**
 * The server's door is open, said twice: once in front of the reader, and after that in the
 * corner of the screen.
 *
 * It used to be a banner, standing at the top of the instruments and again on the remote page
 * for as long as the condition lasted. That is a fair description of the condition - it is
 * standing, not an event - but it was measured taking 12.7% of a phone's screen, four lines of
 * a sentence the owner had read weeks before, on the screen he looks at all day.
 *
 * So the sentence is now a dialog he reads once and dismisses, offered again a month later if
 * the door is still open (see lib/securityNotice), and what stays behind on the screen is a
 * mark: enough to say the condition is still there, small enough to live beside the readings,
 * and it opens the page that says what to do about it.
 *
 * Still in two places on purpose. On the instruments it is the screen an owner looks at all day,
 * so the condition cannot go unnoticed. On the remote page it is the reason the buttons beside
 * it are missing: with the door open and unanswered for, the plugin refuses pairing writes, and
 * a page that hid the controls without saying why would read as a fault in the product.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Sheet } from "siparu-ui";
import { noticeShouldOpen, readAck, writeAck } from "../lib/securityNotice";

/** Where the page that explains it lives. One string, so the mark and the dialog cannot
 *  disagree about it. */
export const SECURITY_HELP = "/security";

function headline(locked: boolean): string {
  return locked ? "Signal K security is off · pairing is locked" : "Signal K security is off";
}

/**
 * The mark left on the screen once the dialog has been read.
 *
 * A button and not a line of text: what it is for is the page behind it, and a reader who has
 * dismissed the sentence should still be one press from what to do about it.
 */
export default function SecurityWarning({
  on,
  locked,
}: {
  on: boolean | undefined;
  /** Writes are refused as well as unguarded, which changes what there is to say. */
  locked: boolean;
}) {
  const navigate = useNavigate();
  if (!on) return null;
  return (
    <button
      type="button"
      className="sec-flag"
      onClick={() => navigate(SECURITY_HELP)}
      title="How to turn on Signal K security"
    >
      <span className="sf-mark" aria-hidden="true">
        !
      </span>
      <span className="sf-t">{headline(locked)}</span>
      <span className="sf-go">How to fix</span>
    </button>
  );
}

/**
 * The dialog itself, opened once per device and again a month on.
 *
 * It is mounted by the layout rather than by a screen, because the condition belongs to the
 * server and not to whichever tab the app happened to open on: an owner who lands on the logbook
 * has the same open door as one who lands on the instruments.
 */
export function SecurityNotice({
  on,
  locked,
  now,
}: {
  on: boolean | undefined;
  locked: boolean;
  /** Injected so the month can be tested at its edges rather than at whatever moment the suite
   *  happens to run. Defaults to the clock in every real render. */
  now?: number;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);
  // Once per mount: asked when the status first says the door is open, and not again as the
  // status keeps arriving. A dialog that reopened on every poll could not be dismissed.
  const asked = useRef(false);
  // Not over the page that answers it. A reader who arrived there - from the mark, or from a
  // bookmark - is already doing the thing the dialog would ask him to do, and covering the
  // instructions with the complaint is the product interrupting its own answer.
  const onHelpPage = pathname === SECURITY_HELP;

  useEffect(() => {
    if (asked.current) return;
    if (on === undefined) return;  // The first status has not landed; nothing has been decided.
    asked.current = true;
    const due = noticeShouldOpen({
      securityOff: on,
      onHelpPage,
      now: now ?? Date.now(),
      acknowledgedAt: readAck(),
    });
    if (due) setOpen(true);
  }, [on, onHelpPage, now]);

  if (!open) return null;

  /** Recorded on the way out, whichever way it was closed. What the record is for is having put
   *  the sentence in front of the reader, and every exit did that. */
  const acknowledge = () => {
    writeAck(now ?? Date.now());
    setOpen(false);
  };

  return (
    <Sheet
      title={headline(locked)}
      eyebrow="Signal K"
      onClose={acknowledge}
      closeRef={closeRef}
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              writeAck(now ?? Date.now());
              closeRef.current?.();
              navigate(SECURITY_HELP);
            }}
          >
            How to fix it
          </button>
          <button type="button" className="btn primary" onClick={() => closeRef.current?.()}>
            Got it
          </button>
        </>
      }
    >
      <p className="sn-p">
        {locked
          ? "Anyone on this network could link this boat to another account or cut her loose, " +
            "so pairing, unpairing and log edits stay locked."
          : "Anyone who can reach this network can link this boat to their account, and the " +
            "only sign here would be a linked account you do not recognise."}
      </p>
      <p className="sn-p quiet">
        Adding an account in Signal K closes it. Until then this stays in the corner of the
        screen, and you will be asked again in a month.
      </p>
    </Sheet>
  );
}
