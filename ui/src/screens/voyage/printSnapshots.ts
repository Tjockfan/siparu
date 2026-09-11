/**
 * The maps that are open when the page is printed.
 *
 * A track map draws through WebGL, and a WebGL canvas prints blank unless its drawing
 * buffer is kept from frame to frame, which is a cost paid on every frame for a page
 * printed twice a season. So the canvas is not printed. Each open map registers a way to
 * take its own picture instead, and the Print button asks every one of them for it before
 * the dialog opens; the picture is what goes on the paper.
 */
const takers = new Set<() => Promise<void>>();

/** Called by a map when it mounts; the returned function is called when it unmounts. */
export function registerMapSnapshot(take: () => Promise<void>): () => void {
  takers.add(take);
  return () => {
    takers.delete(take);
  };
}

/** Every open map takes its picture. A map that cannot is left out, not waited on forever. */
export async function snapshotMapsForPrint(): Promise<void> {
  await Promise.all([...takers].map((take) => take().catch(() => undefined)));
}
