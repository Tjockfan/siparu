import type { TrackPoint, TrackResult } from './contract'

/**
 * The most fixes a track carries over the wire.
 *
 * A day under way at roughly 1 Hz is tens of thousands of fixes; a line on a chart needs a small
 * fraction of that, and the shore's request waits on a single reply with a fixed timeout. The
 * local REST is left untouched - a browser aboard has no such limit and can ask for every fix -
 * so this caps only what crosses the wire.
 */
export const MAX_TRACK_POINTS = 2000

/**
 * Thin a track to at most `max` fixes at an even stride, always keeping the first and last so the
 * line still starts and ends where the voyage did. Returns the track untouched when it already
 * fits, with a flag saying whether anything was dropped - a faithful shape, not every fix.
 */
export function decimateTrack(points: TrackPoint[], max = MAX_TRACK_POINTS): TrackResult {
  if (points.length <= max || max < 2) return { track: points, decimated: false }
  const stride = Math.ceil(points.length / max)
  const out: TrackPoint[] = []
  // length > max >= 2 here, so the first and last are always present.
  for (let i = 0; i < points.length; i += stride) out.push(points[i]!)
  const last = points[points.length - 1]!
  if (out[out.length - 1] !== last) out.push(last)
  return { track: out, decimated: true }
}
