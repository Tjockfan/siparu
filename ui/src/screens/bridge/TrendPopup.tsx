/**
 * One reading over the past, large enough to read: a pannable line chart in a Sheet, opened by
 * tapping the cell that carries the reading on the bridge.
 *
 * It draws the barometer and the gust, which differ in the field they read, the colour of their
 * line and the words above it - and in nothing else. Two copies of a chart with a pan gesture,
 * a range selector and a frozen Y axis is one copy too many, so the chart is here and the cells
 * hand in what is theirs.
 *
 * A wide buffer is loaded once per range and the panning is done in the browser, so dragging
 * back through the week costs nothing and the line does not resample under the finger.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "../../index";
import type { SeriesPoint } from "../../data/api";

const H = 3_600_000;
const D = 86_400_000;

type Range = { key: string; label: string; span: number; buffer: number };
// buffer = 3x span, so the window can be panned back two spans beyond where it opened.
const RANGES: Range[] = [
  { key: "24h", label: "24h", span: 24 * H, buffer: 3 * D },
  { key: "7d", label: "7d", span: 7 * D, buffer: 21 * D },
  { key: "30d", label: "30d", span: 30 * D, buffer: 90 * D },
];

/** Catmull-Rom to cubic bezier (the same smoothing the sparklines use). */
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

// Chart viewBox. Wider than it is tall: a trend is read across.
const VW = 520, VH = 240, PADL = 40, PADR = 12, PADT = 14, PADB = 24;
const PLOTW = VW - PADL - PADR;
const PLOTH = VH - PADT - PADB;

function fmtTick(t: number, span: number): string {
  const d = new Date(t);
  if (span <= 2 * D) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function TrendPopup({
  title,
  eyebrow,
  unit,
  reading,
  decimals = 0,
  note,
  /** Which of the two lines this is: the sparkline colour of the cell it opened from. */
  tone,
  /** The least the Y axis may span, in the reading's own unit, so a flat hour is not magnified. */
  floor,
  load,
  onClose,
}: {
  title: string;
  eyebrow: string;
  unit: string;
  reading: number | null;
  decimals?: number;
  note?: ReactNode;
  tone: "baro" | "gust";
  floor: number;
  load: (q: { from: number; to: number; points: number }) => Promise<SeriesPoint[]>;
  onClose: () => void;
}) {
  const [rangeKey, setRangeKey] = useState("24h");
  const [pts, setPts] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [endMs, setEndMs] = useState<number>(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const anchorRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const range = RANGES.find((r) => r.key === rangeKey)!;

  // Held in a ref rather than depended on: the reader is a method of an api object that the app
  // ashore rebuilds as frames arrive, and an effect that watched it would throw the chart away
  // and load it again twice a second under way.
  const loadRef = useRef(load);
  loadRef.current = load;

  // On a range change, load a wide buffer and pin the window to now.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const to = Date.now();
    const from = to - range.buffer;
    anchorRef.current = { from, to };
    (async () => {
      try {
        const series = await loadRef.current({ from, to, points: 240 });
        if (cancelled) return;
        setPts(series);
        setEndMs(to);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message || "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rangeKey, range.buffer]);

  // Pan bounds: the window's right edge cannot go past now, its left not before the oldest row.
  const bounds = useMemo(() => {
    const dataFrom = pts.length ? pts[0].ts : anchorRef.current.from;
    const maxEnd = anchorRef.current.to;
    const minEnd = Math.min(maxEnd, dataFrom + range.span);
    return { minEnd, maxEnd };
  }, [pts, range.span]);

  const winStart = endMs - range.span;

  // The visible window, plus a neighbour either side so the line does not break at the edge.
  const vis = useMemo(() => {
    const inWin = pts.filter((p) => p.ts >= winStart && p.ts <= endMs);
    const firstIdx = pts.findIndex((p) => p.ts >= winStart);
    const lo = firstIdx > 0 ? firstIdx - 1 : 0;
    let hiIdx = pts.length - 1;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].ts <= endMs) { hiIdx = Math.min(pts.length - 1, i + 1); break; }
    }
    return inWin.length ? pts.slice(lo, hiIdx + 1) : [];
  }, [pts, winStart, endMs]);

  // Y axis: what is visible, padded, and never narrower than the floor - a still hour magnified
  // to fill the chart reads as weather.
  const ydom = useMemo(() => {
    if (!vis.length) return { lo: 0, hi: floor };
    const lo = Math.min(...vis.map((p) => p.value));
    const hi = Math.max(...vis.map((p) => p.value));
    const mid = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2 + floor / 6, floor / 2);
    return { lo: Math.floor(mid - half), hi: Math.ceil(mid + half) };
  }, [vis, floor]);

  // Frozen while a finger is down, so panning sideways does not jump the line vertically.
  const frozenY = useRef(ydom);
  const yd = dragging ? frozenY.current : ydom;

  const x = (ts: number) => PADL + ((ts - winStart) / range.span) * PLOTW;
  const y = (v: number) => PADT + PLOTH * (1 - (v - yd.lo) / (yd.hi - yd.lo || 1));

  const path = smooth(vis.map((p) => [x(p.ts), y(p.value)] as [number, number]));
  const area = path
    ? `${path} L ${x(vis[vis.length - 1].ts)},${PADT + PLOTH} L ${x(vis[0].ts)},${PADT + PLOTH} Z`
    : "";

  const yTicks = [0, 0.5, 1].map((f) => Math.round(yd.hi - f * (yd.hi - yd.lo)));
  const xTicks = [0, 0.5, 1].map((f) => winStart + f * range.span);

  // --- Pan ---
  // One update per frame: a pointermove fires far more often than the screen redraws.
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; end: number; w: number } | null>(null);
  const raf = useRef<number | null>(null);
  const lastX = useRef(0);

  const applyPan = () => {
    raf.current = null;
    if (!drag.current) return;
    const dx = lastX.current - drag.current.x;
    const dt = -(dx / drag.current.w) * range.span; // drag right, go back in time
    setEndMs(Math.max(bounds.minEnd, Math.min(bounds.maxEnd, drag.current.end + dt)));
  };
  const onDown = (e: React.PointerEvent) => {
    const w = svgRef.current?.clientWidth ?? VW;
    drag.current = { x: e.clientX, end: endMs, w };
    lastX.current = e.clientX;
    frozenY.current = ydom;
    setDragging(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    lastX.current = e.clientX;
    if (raf.current == null) raf.current = requestAnimationFrame(applyPan);
  };
  const onUp = (e: React.PointerEvent) => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    applyPan();
    drag.current = null;
    setDragging(false);
    svgRef.current?.releasePointerCapture(e.pointerId);
  };

  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  const atNow = endMs >= bounds.maxEnd - 60_000;
  const target = document.querySelector<HTMLElement>(".swiss.sp-screen") ?? document.body;
  const grad = `tp-grad-${tone}`;

  return createPortal(
    <Sheet title={title} eyebrow={eyebrow} onClose={onClose}>
      <div className={`trend-pop tone-${tone}`}>
        <div className="tp-head">
          <div className="tp-now">
            {reading === null ? "·" : reading.toFixed(decimals)}
            <span className="tp-u">{unit}</span>
          </div>
          {note !== null && note !== undefined && <div className="tp-note">{note}</div>}
          <div className="winseg tp-seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={rangeKey === r.key ? "on" : ""}
                onClick={() => setRangeKey(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {err ? (
          <div className="lb-err">{err}</div>
        ) : loading ? (
          <div className="tp-msg">Loading…</div>
        ) : vis.length < 2 ? (
          <div className="tp-msg">Nothing recorded over this range.</div>
        ) : (
          <svg
            ref={svgRef}
            className="tp-chart"
            viewBox={`0 0 ${VW} ${VH}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <defs>
              <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="tp-stop-a" />
                <stop offset="100%" className="tp-stop-b" />
              </linearGradient>
            </defs>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={PADL} x2={VW - PADR} y1={y(v)} y2={y(v)} className="tp-grid" />
                <text x={PADL - 8} y={y(v) + 3} className="tp-ylab">{v}</text>
              </g>
            ))}
            <path d={area} className="tp-area" fill={`url(#${grad})`} />
            <path d={path} className="tp-line" vectorEffect="non-scaling-stroke" />
            {atNow && vis.length > 0 && (
              <circle cx={x(vis[vis.length - 1].ts)} cy={y(vis[vis.length - 1].value)} r={3.5} className="tp-dot" />
            )}
            {xTicks.map((t, i) => (
              <text
                key={t}
                x={i === 0 ? PADL : i === 2 ? VW - PADR : PADL + PLOTW / 2}
                y={VH - 6}
                className="tp-xlab"
                textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              >
                {fmtTick(t, range.span)}
              </text>
            ))}
          </svg>
        )}
      </div>
    </Sheet>,
    target,
  );
}
