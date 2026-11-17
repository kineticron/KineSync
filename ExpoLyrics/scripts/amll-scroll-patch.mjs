// AMLL 0.6 owns inertia cancellation and frozen manual focus. Keep those
// implementations and adapt KineSync frame scheduling and intentional return input.
export function patchAmllScroll(source) {
  const replacements = [
    ['var ScrollInteractionEngine = class {', `var ScrollInteractionEngine = class {
    layoutRafId = 0;
    touchActive = false;
    ignoreWheelUntil = 0;
    escapeUntil = 0;
    escapeReturning = false;
    returnRequested = false;
    inputSample = false;
    inputOffset = 0;
    escapeTarget = 0;
    escapeAllowed = true;
    returnTarget = 0;
    noteEscapeInput() {
      this.hooks.onInput?.(this.offset);
      if (!Number.isFinite(this.escapeTarget)) { this.escapeReturning = false; return; }
      const previous = this.inputOffset;
      const value = this.offset;
      this.inputOffset = value;
      if (Math.abs(value - previous) < 0.5) return;
      const toward = (value - previous) * (this.escapeTarget - previous) > 0 && Math.abs(value - this.escapeTarget) < Math.abs(previous - this.escapeTarget);
      if (!toward && this.escapeAllowed && !this.escapeUntil) {
        this.escapeUntil = performance.now() + 1000;
        this.hooks.onEscape?.();
      }
      this.escapeReturning = toward;
      this.returnTarget = this.escapeTarget;
    }
    queueScrollUpdate(isContinuous) {
      if (this.inputSample) {
        this.noteEscapeInput();
        this.inputSample = false;
        if (!this.touchActive && this.escapeReturning && Math.abs(this.offset - this.escapeTarget) <= 64) this.returnRequested = true;
      }
      if (this.layoutRafId) cancelAnimationFrame(this.layoutRafId);
      this.layoutRafId = requestAnimationFrame(() => {
        this.layoutRafId = 0;
        this.hooks.onScrollUpdate(isContinuous);
      });
    }`],
    ['onTouchStart = (evt) => {', 'onTouchStart = (evt) => {\n\t\tif (!evt.touches.length) return;\n\t\tthis.touchActive = true;\n\t\tthis.returnRequested = false;\n\t\tthis.inputSample = false;\n\t\tthis.inputOffset = this.offset;\n\t\tthis.escapeReturning = false;\n\t\tthis.hooks.onInput?.(this.offset);'],
    ['onTouchMove = (evt) => {', 'onTouchMove = (evt) => {\n\t\tif (!this.touchActive || !evt.touches.length) return;\n\t\tthis.inputSample = true;'],
    ['onTouchCancel = (_evt) => {', 'onTouchCancel = (_evt) => {\n\t\tthis.touchActive = false;\n\t\tthis.escapeReturning = false;\n\t\tthis.inputSample = false;'],
    ['onTouchEnd = (evt) => {', `onTouchEnd = (evt) => {
        if (!this.touchActive) return;
        if (!evt.touches.length) {
          this.touchActive = false;
          if (!this.escapeUntil && this.escapeAllowed) {
            this.returnRequested = true;
            this.queueScrollUpdate(false);
            return;
          }
          this.hooks.onInput?.(this.offset);
          if (this.escapeReturning && Math.abs(this.returnTarget - this.escapeTarget) <= 1 && Math.abs(this.offset - this.escapeTarget) <= 64) {
            this.returnRequested = true;
            this.queueScrollUpdate(false);
            return;
          }
        }`],
    ['this.hooks.onScrollUpdate(true);\n\t};', 'this.queueScrollUpdate(true);\n\t};'],
    ['onWheel = (evt) => {', 'onWheel = (evt) => {\n\t\tif (performance.now() < this.ignoreWheelUntil) { if (evt.cancelable) evt.preventDefault(); return; }\n\t\tthis.inputOffset = this.offset;\n\t\tthis.inputSample = true;'],
    ['this.hooks.onScrollUpdate(false);', 'this.queueScrollUpdate(false);'],
    ['return this.scrollEndTime !== void 0 && performance.now() - this.scrollEndTime >= AUTO_ALIGN_RESUME_DELAY_MS;',
      'return false; // Timers never resume follow. KineSync handles deliberate return input and Auto.'],
    ['resetScroll(targetOffset = 0) {', 'resetScroll(targetOffset = 0) {\n\t\tthis.touchActive = false;\n\t\tthis.escapeUntil = 0;\n\t\tthis.escapeTarget = targetOffset;\n\t\tthis.returnTarget = targetOffset;\n\t\tthis.inputOffset = targetOffset;\n\t\tthis.escapeReturning = false;\n\t\tthis.returnRequested = false;\n\t\tthis.inputSample = false;\n\t\tthis.ignoreWheelUntil = performance.now() + 120;'],
    ['clearTimers() {', 'clearTimers() {\n\t\tif (this.layoutRafId) cancelAnimationFrame(this.layoutRafId);\n\t\tthis.layoutRafId = 0;'],
    ['onPageHide = () => {\n\t\tthis.isPageVisible = false;', 'onPageHide = () => {\n\t\tthis.scrollEngine.resetScroll(this.scrollEngine.offset);\n\t\tthis.isPageVisible = false;'],
    ['onScrollUpdate: (isContinuous) => {', 'onEscape: () => { this.element.dispatchEvent(new Event("kinesync-escape")); },\n\t\t\tonInput: (offset) => { this.element.dispatchEvent(new CustomEvent("kinesync-input", { detail: { offset, setFollowing: (value) => { this.scrollEngine.escapeAllowed = value; }, setTarget: (value) => { this.scrollEngine.escapeTarget = value; } } })); },\n\t\t\tonScrollUpdate: (isContinuous) => {\n\t\t\t\tthis.element.dispatchEvent(new Event("kinesync-scroll"));\n\t\t\t\tif (this.scrollEngine.returnRequested) this.element.dispatchEvent(new Event("kinesync-return"));\n\t\t\t\telse if (this.scrollEngine.escapeUntil) this.element.dispatchEvent(new Event("kinesync-escape"));'],
  ];
  for (const [original, replacement] of replacements) {
    if (source.split(original).length !== 2) throw new Error('AMLL scroll patch no longer matches upstream. Review its gesture lifecycle.');
    source = source.replace(original, replacement);
  }
  return source;
}
