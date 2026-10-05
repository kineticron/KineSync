// Patch the bundle input, not node_modules. Upstream resetScroll() leaves its
// private inertia RAF alive; every subsequent frame overwrites the reset.
export function patchAmllScroll(source) {
  const start = source.indexOf('function attachPlayerScrollHandlers(');
  const end = source.indexOf('\n//#endregion', start);
  if (start < 0 || end < 0 || source.indexOf('function attachPlayerScrollHandlers(', start + 1) >= 0) {
    throw new Error('AMLL scroll adapter no longer matches upstream. Review its gesture lifecycle.');
  }
  const handler = `function attachPlayerScrollHandlers(element, scrollState, callbacks) {
    let frameId = null, dragging = false, velocity = 0;
    let originX = 0, originY = 0, originOffset = 0, lastY = 0, lastAt = 0;
    let ignoreWheelUntil = 0;
    const layout = () => callbacks.onLayout(true, true);
    const cancel = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null; velocity = 0; dragging = false;
      scrollState.isUserScrolling = false;
    };
    scrollState.cancelMomentum = () => { cancel(); ignoreWheelUntil = performance.now() + 120; };
    const queueLayout = () => {
      if (frameId === null) frameId = requestAnimationFrame(() => { frameId = null; layout(); });
    };
    element.addEventListener('touchstart', event => {
      if (!event.touches.length || !callbacks.onBeginScroll()) return;
      event.preventDefault(); cancel(); ignoreWheelUntil = 0;
      dragging = true; scrollState.isUserScrolling = true;
      originX = event.touches[0].screenX;
      originY = lastY = event.touches[0].screenY;
      originOffset = scrollState.scrollOffset; lastAt = performance.now();
      queueLayout();
    }, { passive: false });
    element.addEventListener('touchmove', event => {
      if (!dragging || !event.touches.length) return;
      event.preventDefault();
      const y = event.touches[0].screenY, now = performance.now();
      const dt = Math.max(4, now - lastAt);
      velocity = Math.max(-3.5, Math.min(3.5, .7 * (y - lastY) / dt + .3 * velocity));
      lastY = y; lastAt = now;
      scrollState.scrollOffset = originOffset - (y - originY);
      clampPlayerScrollOffset(scrollState); queueLayout();
    }, { passive: false });
    element.addEventListener('touchend', event => {
      if (!dragging) return;
      event.preventDefault();
      const touch = event.changedTouches[0];
      const tap = touch && Math.abs(touch.screenX - originX) < 10 && Math.abs(touch.screenY - originY) < 10;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null; dragging = false;
      if (tap) {
        cancel(); callbacks.onEndScroll(); layout();
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (target instanceof HTMLElement && callbacks.containsTarget(target)) callbacks.clickTarget(target);
        return;
      }
      if (performance.now() - lastAt > 100) velocity = 0;
      let previous = performance.now();
      const coast = now => {
        frameId = null;
        const dt = Math.max(0, Math.min(32, now - previous)); previous = now;
        const before = scrollState.scrollOffset;
        scrollState.scrollOffset -= velocity * dt; clampPlayerScrollOffset(scrollState);
        velocity *= .95 ** (dt / 16); layout();
        if (Math.abs(velocity) > .05 && (dt === 0 || scrollState.scrollOffset !== before)) frameId = requestAnimationFrame(coast);
        else { velocity = 0; scrollState.isUserScrolling = false; callbacks.onEndScroll(); layout(); }
      };
      frameId = requestAnimationFrame(coast);
    }, { passive: false });
    element.addEventListener('touchcancel', () => { cancel(); callbacks.onEndScroll(); layout(); });
    element.addEventListener('wheel', event => {
      event.preventDefault();
      if (performance.now() < ignoreWheelUntil || !callbacks.onBeginScroll()) return;
      cancel(); scrollState.isUserScrolling = true;
      scrollState.scrollOffset += event.deltaY * (event.deltaMode === 0 ? 1 : event.deltaMode === 2 ? element.clientHeight : 50);
      clampPlayerScrollOffset(scrollState); queueLayout();
    }, { passive: false });
    window.addEventListener('pagehide', cancel);
  }`;
  source = source.slice(0, start) + handler + source.slice(end);
  const replacements = [
    ['resetScroll() {\n\t\tresetPlayerScrollState(this.scrollState);', 'resetScroll() {\n\t\tthis.scrollState.cancelMomentum?.();\n\t\tresetPlayerScrollState(this.scrollState);'],
    ['onLayout: (sync, force) => this.calcLayout(sync, force),', 'onLayout: (sync, force) => { this.element.dispatchEvent(new Event("kinesync-scroll")); return this.calcLayout(sync, force); },'],
    ['this.scrollState.isScrolled = true;', 'if (!this.scrollState.isScrolled) this.scrollState.manualAlignIndex = this.timelineState.scrollToIndex;\n\t\t\tthis.scrollState.isScrolled = true;'],
    ['this.scrolledHandler = setTimeout(() => {\n\t\t\t\tthis.scrollState.isScrolled = false;\n\t\t\t\tthis.scrollState.scrollOffset = 0;\n\t\t\t}, 5e3);', '// KineSync owns the explicit Auto scroll button; no competing reset timer.'],
    ['const targetAlignIndex = this.timelineState.scrollToIndex;', 'const targetAlignIndex = this.scrollState.isScrolled ? this.scrollState.manualAlignIndex ?? this.timelineState.scrollToIndex : this.timelineState.scrollToIndex;'],
  ];
  for (const [original, replacement] of replacements) {
    if (source.split(original).length !== 2) throw new Error('AMLL scroll patch no longer matches upstream. Review reset and layout handling.');
    source = source.replace(original, replacement);
  }
  return source;
}
