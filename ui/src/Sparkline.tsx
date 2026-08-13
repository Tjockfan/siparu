/* Siparu - sparkline (Swiss). Smoothed line, optional soft fill + peak dot.
 * Stroke uses a CSS var so it re-themes live (Sun/Night) without a redraw. */

type Props = {
  data: number[];
  /** CSS color/var for line+fill+dot. */
  color: string;
  fill?: boolean;
  peak?: boolean;
  height?: number;
  top?: number;
  className?: string;
};

const W = 150;
const PAD = 3;

/** Catmull-Rom → cubic bezier smoothing. */
function smooth(p: [number, number][]): string {
  if (p.length === 0) return "";
  let d = `M ${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i];
    const b = p[i];
    const c = p[i + 1];
    const e = p[i + 2] || c;
    d += ` C ${b[0] + (c[0] - a[0]) / 6},${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6},${c[1] - (e[1] - b[1]) / 6} ${c[0]},${c[1]}`;
  }
  return d;
}

export default function Sparkline({ data, color, fill, peak, height = 40, top = 5, className }: Props) {
  if (!data || data.length < 2) {
    return <svg className={className} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true" />;
  }
  const H = height;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const mx = max * 1.04;
  const mn = min * 0.96;
  const span = mx - mn || 1;
  const xs = (i: number) => PAD + i * ((W - PAD * 2) / (data.length - 1));
  const ys = (v: number) => top + (H - top - PAD) * (1 - (v - mn) / span);
  const pts = data.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const line = smooth(pts);
  const peakIdx = peak ? data.indexOf(max) : -1;

  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke={color} strokeOpacity={0.18} />
      {fill && <path d={`${line} L ${xs(data.length - 1)},${H} L ${xs(0)},${H} Z`} fill={color} fillOpacity={0.12} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {peakIdx >= 0 && <circle cx={xs(peakIdx)} cy={ys(data[peakIdx])} r={2.6} fill={color} />}
    </svg>
  );
}
