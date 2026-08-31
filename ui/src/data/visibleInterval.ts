/** An interval that pauses while the tab is hidden and, once the tab becomes
 *  visible again, immediately runs fn() once and then restarts. Saves battery
 *  and data (cellular connections aboard). The returned function is the cleanup;
 *  call it in the effect's return. fn does NOT perform the initial call - the
 *  caller does the initial fetch itself (to match the existing effect pattern). */
export function startVisibleInterval(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(fn, ms);
  };
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else {
      fn();
      start();
    }
  };
  if (!document.hidden) start();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
