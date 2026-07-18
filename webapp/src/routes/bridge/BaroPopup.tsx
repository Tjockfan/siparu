/** Barometer detail popup - opens when the baro cell on the Bridge is tapped.
 *  Large line chart + 24h/7d/30d range; dragging left/right with a finger
 *  shifts the time window (pan). Data comes from logbook snapshots (air_pressure_pa);
 *  a wide buffer is loaded once and panning is done client-side (smooth, no refetch).
 *  The Sheet primitive is the shell: tapping the scrim (outside the chart) closes it. */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "siparu-ui";
import { api } from "../../lib/api";

const H = 3_600_000;
const D = 86_400_000;

type Range = { key: string; label: string; span: number; buffer: number };
// buffer = 3x span → can pan back up to 2 spans beyond the window.
const RANGES: Range[] = [
  { key: "24h", label: "24h", span: 24 * H, buffer: 3 * D },
  { key: "7d", label: "7d", span: 7 * D, buffer: 21 * D },
  { key: "30d", label: "30d", span: 30 * D, buffer: 90 * D },
];

type Pt = { ts: number; hpa: number };

/** Catmull-Rom → cubic bezier (same smoothing as Sparkline). */
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

// Chart viewBox dimensions.
const VW = 340, VH = 190, PADL = 34, PADR = 10, PADT = 12, PADB = 22;
const PLOTW = VW - PADL - PADR;
const PLOTH = VH - PADT - PADB;

function fmtTick(t: number, span: number): string {
  const d = new Date(t);
  if (span <= 2 * D) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function BaroPopup({
  onClose,
  current,
  delta,
}: {
  onClose: () => void;
  current: number | null;
  delta: number | null;
}) {
  const [rangeKey, setRangeKey] = useState("24h");
  const [pts, setPts] = useState<Pt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [endMs, setEndMs] = useState<number>(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const anchorRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const range = RANGES.find((r) => r.key === rangeKey)!;

  // On range change, load a wide buffer and pin the window to now.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const to = Date.now();
    const from = to - range.buffer;
    anchorRef.current = { from, to };
    (async () => {
      try {
        // Lightweight endpoint: only {ts,hpa}, downsampled to ~160 points on the
        // server (no 40-column over-fetch / 5 MB). The visible window is 1/3 of the
        // buffer ~53 points → fixed grid, no resampling while panning.
        const series = await api.tools.baroSeries({ from, to, points: 160 });
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

  // Pan bounds: the window's right edge can't go past now; its left can't go before the oldest data.
  const bounds = useMemo(() => {
    const dataFrom = pts.length ? pts[0].ts : anchorRef.current.from;
    const maxEnd = anchorRef.current.to;
    const minEnd = Math.min(maxEnd, dataFrom + range.span);
    return { minEnd, maxEnd };
  }, [pts, range.span]);

  const winStart = endMs - range.span;

  // Visible window points (+1 neighbor so the line doesn't break at the edge).
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

  // Y axis: visible min/max + padding, minimum 6 hPa spread (avoid zoom-noise during flat periods).
  const ydom = useMemo(() => {
    if (!vis.length) return { lo: 1000, hi: 1020 };
    let lo = Math.min(...vis.map((p) => p.hpa));
    let hi = Math.max(...vis.map((p) => p.hpa));
    const mid = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2 + 1, 3);
    return { lo: Math.floor(mid - half), hi: Math.ceil(mid + half) };
  }, [vis]);

  // Freeze the Y axis during pan → no vertical jump/jitter while scrolling horizontally.
  const frozenY = useRef(ydom);
  const yd = dragging ? frozenY.current : ydom;

  const x = (ts: number) => PADL + ((ts - winStart) / range.span) * PLOTW;
  const y = (hpa: number) =>
    PADT + PLOTH * (1 - (hpa - yd.lo) / (yd.hi - yd.lo || 1));

  // vis is already a fixed grid (~44 points) - draw directly, no per-frame resampling.
  const path = smooth(vis.map((p) => [x(p.ts), y(p.hpa)] as [number, number]));
  const area = path
    ? `${path} L ${x(vis[vis.length - 1].ts)},${PADT + PLOTH} L ${x(vis[0].ts)},${PADT + PLOTH} Z`
    : "";

  const yTicks = [0, 0.5, 1].map((f) => Math.round(yd.hi - f * (yd.hi - yd.lo)));
  const xTicks = [0, 0.5, 1].map((f) => winStart + f * range.span);

  // --- Pan (drag left/right with a finger) ---
  // Single update per frame via rAF: pointermove fires at ~120Hz, we apply it
  // once per frame → no stutter.
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; end: number; w: number } | null>(null);
  const raf = useRef<number | null>(null);
  const lastX = useRef(0);

  const applyPan = () => {
    raf.current = null;
    if (!drag.current) return;
    const dx = lastX.current - drag.current.x;
    const dt = -(dx / drag.current.w) * range.span; // drag right → go back in time
    setEndMs(Math.max(bounds.minEnd, Math.min(bounds.maxEnd, drag.current.end + dt)));
  };
  const onDown = (e: React.PointerEvent) => {
    const w = svgRef.current?.clientWidth ?? VW;
    drag.current = { x: e.clientX, end: endMs, w };
    lastX.current = e.clientX;
    frozenY.current = ydom; // keep Y fixed throughout the pan
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
    applyPan(); // apply the final position
    drag.current = null;
    setDragging(false);
    svgRef.current?.releasePointerCapture(e.pointerId);
  };

  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);

  const arrow = delta === null ? "" : delta < -0.1 ? "▼" : delta > 0.1 ? "▲" : "▬";
  const atNow = endMs >= bounds.maxEnd - 60_000;

  const target = document.querySelector<HTMLElement>(".swiss.sp-screen") ?? document.body;

  return createPortal(
    <Sheet title="Barometer" eyebrow="hPa · pressure" onClose={onClose}>
      <div className="baro-pop">
        <div className="bp-head">
          <div className="bp-now">
            {current === null ? "·" : Math.round(current)}
            <span className="bp-u">hPa</span>
          </div>
          {delta !== null && (
            <div className="bp-delta">{arrow} {Math.abs(delta).toFixed(1)} / 3h</div>
          )}
          <div className="seg bp-seg">
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
          <div className="bp-msg">Loading…</div>
        ) : vis.length < 2 ? (
          <div className="bp-msg">No barometric data for this range.</div>
        ) : (
          <>
            <svg
              ref={svgRef}
              className="bp-chart"
              viewBox={`0 0 ${VW} ${VH}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {/* soft green gradient under the line (gust sparkline feel) */}
              <defs>
                <linearGradient id="bp-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.3 }} />
                  <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              {/* horizontal grid + hPa labels */}
              {yTicks.map((v) => (
                <g key={v}>
                  <line x1={PADL} x2={VW - PADR} y1={y(v)} y2={y(v)} className="bp-grid" />
                  <text x={PADL - 6} y={y(v) + 3} className="bp-ylab">{v}</text>
                </g>
              ))}
              <path d={area} className="bp-area" fill="url(#bp-grad)" />
              <path d={path} className="bp-line" vectorEffect="non-scaling-stroke" />
              {/* marker at the current point (when the window end = now) */}
              {atNow && vis.length > 0 && (
                <circle cx={x(vis[vis.length - 1].ts)} cy={y(vis[vis.length - 1].hpa)} r={3} className="bp-dot" />
              )}
              {/* time labels */}
              {xTicks.map((t, i) => (
                <text
                  key={t}
                  x={i === 0 ? PADL : i === 2 ? VW - PADR : PADL + PLOTW / 2}
                  y={VH - 6}
                  className="bp-xlab"
                  textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
                >
                  {fmtTick(t, range.span)}
                </text>
              ))}
            </svg>
          </>
        )}
      </div>
    </Sheet>,
    target,
  );
}
