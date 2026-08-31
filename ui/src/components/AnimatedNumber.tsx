import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useSpring, useMotionValueEvent } from "motion/react";

/**
 * Renders a numeric value with a smooth spring transition. Across poll
 * intervals (5s) values do not jump, they flow. When value is null it shows
 * "·" with no animation. Do NOT use for degree (wrapping) values - only for
 * monotonically changing values like SOG/DEPTH.
 */
type Props = {
  value: number | null;
  digits?: number;
  className?: string;
  style?: CSSProperties;
};

function fmt(v: number, digits: number): string {
  if (Number.isNaN(v)) return "·";
  return digits > 0 ? v.toFixed(digits) : String(Math.round(v));
}

export default function AnimatedNumber({ value, digits = 0, className, style }: Props) {
  const spring = useSpring(value ?? 0, { stiffness: 140, damping: 22, mass: 0.6 });
  const [text, setText] = useState(value === null ? "·" : fmt(value, digits));

  useEffect(() => {
    if (value !== null) spring.set(value);
  }, [value, spring]);

  useMotionValueEvent(spring, "change", (v) => {
    if (value !== null) setText(fmt(v, digits));
  });

  // When value === null the spring is not running - we derive the text at
  // render time, without tripping the setState-in-effect rule.
  const display = value === null ? "·" : text;
  return (
    <span className={className} style={style}>
      {display}
    </span>
  );
}
