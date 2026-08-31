/**
 * Which log to open.
 *
 * A ship keeps two, and they are kept by two people. Putting both in one table meant a
 * three-engine boat had thirty columns behind a picker, and the reader who wanted the deck log
 * had to say so every time. So the choice is made once, at the door, and the page he lands on
 * is the book he asked for.
 *
 * Nothing is fetched here on purpose. What each book holds is a fact about the two logs rather
 * than about this boat's wiring, so the door does not need to know what she is reporting to
 * name them - and a page that opened by loading a month of rows to decide what to write on two
 * cards would be slower than the page it leads to.
 */
import { Link } from "react-router-dom";
import { ArrowRight, BridgeLogIcon, EngineLogIcon } from "../../index";
import { useHref } from "../../data/routes";

const BOOKS = [
  {
    to: "/logbook/bridge",
    name: "Bridge",
    keeper: "Chief officer",
    holds: "Position, course and speed, the weather she ran in and the water under her.",
    Icon: BridgeLogIcon,
  },
  {
    to: "/logbook/engine",
    name: "Engine",
    keeper: "Chief engineer",
    holds: "Engines, generators and tanks, as she reported them.",
    Icon: EngineLogIcon,
  },
] as const;

export default function LogbookChooser() {
  const href = useHref();
  return (
    <div className="lb-door">
      <div className="lbd-cards">
        {BOOKS.map(({ to, name, keeper, holds, Icon }) => (
          <Link key={to} to={href(to)} replace className="lbd-card">
            <Icon size={42} />
            <span className="lbd-n">{name}</span>
            <span className="lbd-k">{keeper}</span>
            <span className="lbd-h">{holds}</span>
            <span className="lbd-go">
              Open <ArrowRight size={15} />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
