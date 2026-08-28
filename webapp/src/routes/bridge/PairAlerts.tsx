/**
 * What the instruments still say about the link ashore, now that the link has a page.
 *
 * The pairing band moved to the Remote tab and took the account's address, the codes and the
 * fingerprints with it. Three things could not go with it, because they are not looked up -
 * they have to be noticed, and the screen an owner has open is this one:
 *
 *   - the server's door standing open, which is the condition the whole product rests on;
 *   - a boat that cannot seal to anybody, which looks exactly like a healthy boat from ashore
 *     (she says "sending", nothing arrives, and only this screen knows the difference);
 *   - a key on her list that nothing she trusts vouched for, which is what somebody adding a
 *     reader of their own looks like from the helm.
 *
 * They are stated here and answered there: each of the last two is one line that names the
 * condition and opens the page holding the detail. Anything an owner merely wants to check -
 * which screens are sealed to, what the account is - is not here and should not be.
 */
import { Link } from "react-router-dom";
import { api, type PairScreen, type SealingStatus } from "../../lib/api";
import { screenRefusals, sealingNotice } from "../../lib/sealing";
import { usePolling } from "../../lib/usePolling";
import SecurityWarning from "../../components/SecurityWarning";

/** A standing condition, not an event: the slow poll is the honest cadence for one. */
const POLL_MS = 30_000;

/** One line of alarm, and the page that answers it. */
function Alert({ title, detail, tone }: { title: string; detail: string; tone?: "asking" }) {
  return (
    <Link to="/remote" className={`pair go ${tone ?? "warn"}`}>
      <div className="pl">
        <div className="t">{title}</div>
        <div className="s">{detail}</div>
      </div>
      <span className="pbtn ghost">Remote</span>
    </Link>
  );
}

export default function PairAlerts({ sealing }: { sealing?: SealingStatus | null }) {
  const { data } = usePolling<PairScreen>(() => api.pair.status(), POLL_MS, []);

  const silent = sealingNotice(sealing);
  const refusals = screenRefusals(sealing);
  const unapproved = refusals?.unapproved.length ?? 0;

  return (
    <>
      <SecurityWarning on={data?.security_off} locked={data?.pairing_locked === true} />
      {/* Somebody is standing at a phone waiting for this, and the tap that answers it can only
          be made here, aboard. It is the one alert on this screen that is about a person rather
          than a condition, so it is dressed as the panel dresses that state. */}
      {data?.state === "awaiting_approval" && (
        <Alert
          title="Someone wants to pair"
          detail="A phone or a browser is asking to watch this boat. Nothing is linked until it is approved from aboard."
          tone="asking"
        />
      )}
      {silent && <Alert title={silent.title} detail={silent.detail} />}
      {unapproved > 0 && (
        <Alert
          title="She will not seal to these screens"
          detail={
            unapproved === 1
              ? "One key on her list has nothing she trusts behind it, so it receives nothing at all."
              : `${unapproved} keys on her list have nothing she trusts behind them, so they receive nothing at all.`
          }
        />
      )}
    </>
  );
}
