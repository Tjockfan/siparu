/* Siparu - Swiss line-icon set (1.6–2px stroke, no fill, currentColor).
 * Paths lifted from the design handoff prototypes. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const ChevLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const TelemetryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
    <path d="M12 17l4.5-5" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
    <circle cx={12} cy={17} r={1.6} fill="currentColor" />
  </Svg>
);

export const LogbookIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx={5} cy={7} r={1.3} fill="currentColor" />
    <circle cx={5} cy={12} r={1.3} fill="currentColor" />
    <circle cx={5} cy={17} r={1.3} fill="currentColor" />
    <path d="M9 7h11M9 12h11M9 17h7" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
  </Svg>
);

export const MapIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s6.5-6 6.5-11A6.5 6.5 0 1 0 5.5 10c0 5 6.5 11 6.5 11Z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    <circle cx={12} cy={9.5} r={2.4} stroke="currentColor" strokeWidth={1.7} />
  </Svg>
);

export const VoyageIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 18C12 18 11 7.5 18 7" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeDasharray="0.2 3.4" />
    <circle cx={6} cy={18} r={2.1} fill="currentColor" />
    <circle cx={18} cy={7} r={2.1} fill="none" stroke="currentColor" strokeWidth={1.7} />
  </Svg>
);

export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

export const Glass = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3h8l-1 6a3 3 0 0 1-6 0L8 3Z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    <path d="M12 15v5M9 21h6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
  </Svg>
);

export const Clock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx={12} cy={12} r={8.5} stroke="currentColor" strokeWidth={1.7} />
    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
  </Svg>
);

export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx={11} cy={11} r={7} stroke="currentColor" strokeWidth={1.8} />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
  </Svg>
);

export const Camera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    <circle cx={12} cy={13} r={3.4} stroke="currentColor" strokeWidth={1.7} />
  </Svg>
);

export const Report = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
    <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
  </Svg>
);

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
  </Svg>
);

/* Brand mark - the one glyph outside the line-icon set above: it keeps its own
 * red, and it carries no size prop because each surface sizes it against its
 * wordmark (see .sp-glyph in swiss.css). The light parts follow currentColor,
 * so the mark inherits the wordmark's colour in both themes.
 * The viewBox is cropped to the ink, with no dead space above or below: that
 * lets the glyph be sized in em straight off the wordmark beside it, instead of
 * a box whose ink filled only its middle third. The outline square is inset to
 * 5.4 units because an SVG stroke straddles its path, so a 7-unit path would
 * render larger on the outside than the solid square it is twinned with. */
export const BrandMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 22 7" aria-hidden="true" focusable="false">
    <rect x="0" y="0" width="7" height="7" fill="#e5484d" />
    <line
      x1="8.4"
      y1="3.5"
      x2="13.6"
      y2="3.5"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeDasharray="2 1.2"
      opacity={0.85}
    />
    <rect x="15.8" y="0.8" width="5.4" height="5.4" fill="none" stroke="currentColor" strokeWidth={1.6} />
  </svg>
);

/* Theme toggle icons - night/day. Same line-icon language. */
export const MoonIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <path
      d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  </Svg>
);

export const SunIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth={1.8} />
    <path
      d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    />
  </Svg>
);
