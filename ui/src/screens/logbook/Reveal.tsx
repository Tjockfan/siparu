/**
 * The container a panel is opened and shut in.
 *
 * A panel drawn only while it is wanted cannot be seen leaving: the flag goes false, React
 * takes it out of the document, and there is nothing left to animate. This holds it one motion
 * longer. The flag says shut, the stylesheet plays the drawer backwards over the same
 * distance it opened, and the panel goes only when that motion ends.
 *
 * Height is animated as a grid row rather than as a number, because how tall a panel stands
 * depends on how much of it wrapped, and no number written here would survive that.
 *
 * The inner box is not decoration. A grid row of zero shrinks what is in it to no content, and
 * a panel with padding is still as tall as its padding at that point - the panels here stood
 * 38px high while the row said nothing, and the table jumped that far the moment the panel
 * left. So the row holds a plain box that has no padding of its own and can honestly be zero,
 * and the panel does its shrinking inside that.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

export default function Reveal({
  open,
  style,
  cls,
  children,
}: {
  open: boolean;
  /** The lane count, so what opens is as wide as the windows it sits between. */
  style?: CSSProperties;
  /** The table's shape, for the same reason: two lanes lead the engineer's, and a panel sized
   *  for one ends short of the table it belongs to. */
  cls?: string;
  children: ReactNode;
}) {
  const [drawn, setDrawn] = useState(open);
  // Opening is immediate and closing is not, so the two are not the same state. Set during
  // the render that asks for it rather than in an effect: an effect would cost a frame, and
  // the frame it costs is the first one of the motion.
  if (open && !drawn) setDrawn(true);
  if (!drawn) return null;
  return (
    <div
      className={`lb-open${open ? "" : " shut"}${cls ?? ""}`}
      style={style}
      onAnimationEnd={(e) => {
        // This container's own motion only: something inside it that animates one day must
        // not be what takes the panel out of the document.
        if (e.target === e.currentTarget && !open) setDrawn(false);
      }}
    >
      <div className="lb-open-in">{children}</div>
    </div>
  );
}
