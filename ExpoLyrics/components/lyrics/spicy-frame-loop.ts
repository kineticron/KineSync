/** One wakeable animation loop. No polling while paused, hidden or static. */
export function createLyricsFrameLoop(driver: {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
  // Zero continues at display refresh rate; a delay sleeps until the next cue.
  render: () => number | null;
}) {
  let frameId: number | null = null;
  let timerId: number | null = null;
  let suspended = false;
  const stop = () => {
    if (frameId !== null) driver.cancelFrame(frameId);
    if (timerId !== null) driver.clearTimer(timerId);
    frameId = timerId = null;
  };
  const wake = () => {
    if (suspended) return;
    if (timerId !== null) driver.clearTimer(timerId);
    timerId = null;
    if (frameId === null) frameId = driver.requestFrame(frame);
  };
  const frame = () => {
    frameId = null;
    if (suspended) return;
    const delay = driver.render();
    if (delay === null || suspended) return;
    if (delay <= 0) wake();
    else timerId = driver.setTimer(() => { timerId = null; wake(); }, delay);
  };
  return {
    wake,
    stop,
    setSuspended(value: boolean) {
      suspended = value;
      if (value) stop();
      else wake();
    },
  };
}
