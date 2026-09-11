/**
 * Which passages are open at once.
 *
 * An open row carries a live map, and a live map is a WebGL context with its own tiles in
 * memory: a handful is fine on a desk, a dozen is not fine on the tablet at the helm, and
 * the browser starts quietly killing the oldest contexts somewhere past eight. So the list
 * keeps a few open and lets the oldest go when another is asked for, which is also what a
 * reader comparing passages does by hand.
 */
export const OPEN_ROWS_LIMIT = 3;

/** The rows open after `id` is pressed: closed if it was open, else opened, oldest out first. */
export function toggleOpen(open: readonly number[], id: number, limit = OPEN_ROWS_LIMIT): number[] {
  if (open.includes(id)) return open.filter((x) => x !== id);
  const next = [...open, id];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
