/** Depth micro-diagnosis - a reasoned explanation instead of a bare "·"
 *  (fool-proof rule: a signature diagnosis instead of an empty box, yellow ≠ error).
 *  The last_seen_ts in /health.paths distinguishes "no sensor at all (normal)"
 *  from "was present, then went quiet". */
import { formatTimeShort } from './format'

/** Depth concept paths the plugin subscribes to (mirror of plugin/src/metrics.ts). */
export const DEPTH_PATHS = [
  'environment.depth.belowTransducer',
  'environment.depth.belowKeel',
  'environment.depth.belowSurface'
] as const

export type DepthDiag =
  | { kind: 'none' }
  | { kind: 'no-sensor' }
  | { kind: 'quiet'; lastTs: number }

export function depthDiagnosis(
  depth: number | null,
  healthPaths: Record<string, { last_seen_ts: number }> | null | undefined
): DepthDiag {
  if (depth !== null) return { kind: 'none' }
  // If health hasn't arrived yet (or an older plugin doesn't return paths),
  // stay silent - show a plain "·" rather than wrongly claiming "no sensor".
  if (!healthPaths) return { kind: 'none' }
  let last = 0
  for (const p of DEPTH_PATHS) {
    const e = healthPaths[p]
    if (e && e.last_seen_ts > last) last = e.last_seen_ts
  }
  return last === 0 ? { kind: 'no-sensor' } : { kind: 'quiet', lastTs: last }
}

const DAY_MS = 86_400_000

/** Labels are sized for a narrow phone cell (~16 chars); "\n" is a deliberate
 *  line break (CSS white-space: pre-line). Time format matches the GUST label. */
export function depthDiagLabel(diag: DepthDiag, now: number): string | null {
  switch (diag.kind) {
    case 'none':
      return null
    case 'no-sensor':
      return 'NO SENSOR\nNORMAL'
    case 'quiet': {
      const age = now - diag.lastTs
      // For silence older than 24h a clock time is misleading ("14:02" of which day?)
      if (age >= DAY_MS) return `QUIET · ${Math.floor(age / DAY_MS)}d`
      return `QUIET · ${formatTimeShort(diag.lastTs)}`
    }
  }
}
