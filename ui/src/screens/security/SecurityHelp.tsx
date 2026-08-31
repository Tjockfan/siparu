/**
 * How to close the server's door, written for the person standing in front of it.
 *
 * It lives in the app rather than on the web because of where it is read: at the boat, on the
 * same machine that is serving this page, often with no connection ashore. A link to a website
 * is a page that opens everywhere except the one place it is needed.
 *
 * The steps are Signal K's own, taken off its admin screens rather than remembered, and named
 * the way it names them so they can be followed by eye. When those screens change, this page is
 * wrong and has to be corrected; that is the price of writing instructions for another product,
 * and it is cheaper than sending an owner to a page in someone else's words.
 */
import { Link } from "react-router-dom";
import { ArrowRight } from "../../index";
import { useHref } from "../../data/routes";

/**
 * Where Signal K's admin pages are. Aboard they are served by the same server this app is, so
 * the path is all that is needed - and it stays right whatever address, port or tunnel the boat
 * is reached on. Ashore there is no such path: the page is read on a different server from the
 * one it is about, so the step names the place instead of linking to it.
 */
export const ADMIN_SECURITY = "/admin/#/security/users";

export default function SecurityHelp({ admin }: { admin?: string }) {
  const href = useHref();
  return (
    <div className="doc">
      <div className="doc-in">
        <div className="doc-eyebrow">Signal K</div>
        <h1 className="doc-h">Turning on security</h1>

        <p className="doc-lead">
          Signal K is running without an account on it. Anyone who can reach this network can
          read the boat, and can use this plugin's own controls to link her to another account or
          cut her loose. Until there is an account, Siparu refuses those writes: pairing,
          unpairing and log edits stay locked.
        </p>

        <h2 className="doc-h2">What to do</h2>
        <ol className="doc-steps">
          <li>
            <b>Open Signal K's admin pages.</b>{" "}
            {admin ? (
              <>
                They are on this same server, at{" "}
                <a href={admin} target="_blank" rel="noreferrer">
                  /admin
                </a>
                .
              </>
            ) : (
              <>
                They are on the boat's own server, under <b>/admin</b>: open them from a device on
                her network, the way you open her dashboard aboard.
              </>
            )}{" "}
            Nothing here is a Siparu account: this is the boat's own server, and the account you
            are about to make lives on board.
          </li>
          <li>
            <b>Go to Security, then Users.</b> With no account yet, that page offers to make the
            first one.
          </li>
          <li>
            <b>Pick a username and a password.</b> Write them down somewhere that is not the boat.
            There is no reset from ashore.
          </li>
          <li>
            <b>Press Enable, then Restart.</b> Signal K writes the account down but keeps running
            open until it is restarted; it says so in red under the form. The Restart button is at
            the top of its admin pages. Log in when it comes back.
          </li>
          <li>
            <b>Decide about "Allow Readonly Access".</b> It is under Security, then Settings, and
            newer servers also ask on the form you just filled in. Ticked, anyone on the network
            can still read the boat and use this app without logging in, and only the controls
            that change something ask for the password. Unticked, everything asks. Signal K's own
            note is that readonly access exposes your data on the local network and potentially
            the public internet, so leave it off on a shared crew or marina network and on only
            where you know who is on the wire.
          </li>
        </ol>

        <h2 className="doc-h2">After that</h2>
        <p className="doc-p">
          This notice stops once the server is back up and asking for an account. It follows
          whether the server asks at all, not who is allowed in, so it clears whichever way you
          answer the readonly question. Siparu's locked writes unlock for anyone logged in with
          admin rights.
        </p>

        <h2 className="doc-h2">If the network really is yours</h2>
        <p className="doc-p">
          On a boat with nothing else on her wire, you can leave the server open and tell the
          plugin you have decided so: the setting is in Signal K under Apps &amp; Plugins, in
          Siparu's own configuration. The writes unlock. The notice stays, because it reports the
          door and not the decision: the server is still open. It is the weaker answer of the two,
          and it is not the one to pick because the password is a nuisance.
          An open server also lets anything on that network install code, which no setting of
          ours can hold shut.
        </p>

        <div className="doc-back">
          <Link to={href("/")} className="doc-go">
            Back to the boat <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </div>
  );
}
