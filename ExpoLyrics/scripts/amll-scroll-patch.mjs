// AMLL 0.6 owns inertia cancellation and frozen manual focus. Keep those
// implementations and adapt only KineSync's frame scheduling and Auto button.
export function patchAmllScroll(source) {
  const replacements = [
    ['var ScrollInteractionEngine = class {', `var ScrollInteractionEngine = class {
    layoutRafId = 0;
    touchActive = false;
    ignoreWheelUntil = 0;
    queueScrollUpdate(isContinuous) {
      if (this.layoutRafId) cancelAnimationFrame(this.layoutRafId);
      this.layoutRafId = requestAnimationFrame(() => {
        this.layoutRafId = 0;
        this.hooks.onScrollUpdate(isContinuous);
      });
    }`],
    ['onTouchStart = (evt) => {', 'onTouchStart = (evt) => {\n\t\tif (!evt.touches.length) return;\n\t\tthis.touchActive = true;'],
    ['onTouchMove = (evt) => {', 'onTouchMove = (evt) => {\n\t\tif (!this.touchActive || !evt.touches.length) return;'],
    ['onTouchCancel = (_evt) => {', 'onTouchCancel = (_evt) => {\n\t\tthis.touchActive = false;'],
    ['onTouchEnd = (evt) => {', 'onTouchEnd = (evt) => {\n\t\tif (!this.touchActive) return;\n\t\tif (!evt.touches.length) this.touchActive = false;'],
    ['this.hooks.onScrollUpdate(true);\n\t};', 'this.queueScrollUpdate(true);\n\t};'],
    ['onWheel = (evt) => {', 'onWheel = (evt) => {\n\t\tif (performance.now() < this.ignoreWheelUntil) { if (evt.cancelable) evt.preventDefault(); return; }'],
    ['this.hooks.onScrollUpdate(false);', 'this.queueScrollUpdate(false);'],
    ['return this.scrollEndTime !== void 0 && performance.now() - this.scrollEndTime >= AUTO_ALIGN_RESUME_DELAY_MS;',
      'return false; // KineSync resumes only through its explicit Auto scroll button.'],
    ['resetScroll(targetOffset = 0) {', 'resetScroll(targetOffset = 0) {\n\t\tthis.touchActive = false;\n\t\tthis.ignoreWheelUntil = performance.now() + 120;'],
    ['clearTimers() {', 'clearTimers() {\n\t\tif (this.layoutRafId) cancelAnimationFrame(this.layoutRafId);\n\t\tthis.layoutRafId = 0;'],
    ['onPageHide = () => {\n\t\tthis.isPageVisible = false;', 'onPageHide = () => {\n\t\tthis.scrollEngine.resetScroll(this.scrollEngine.offset);\n\t\tthis.isPageVisible = false;'],
    ['onScrollUpdate: (isContinuous) => {', 'onScrollUpdate: (isContinuous) => {\n\t\t\t\tthis.element.dispatchEvent(new Event("kinesync-scroll"));'],
  ];
  for (const [original, replacement] of replacements) {
    if (source.split(original).length !== 2) throw new Error('AMLL scroll patch no longer matches upstream. Review its gesture lifecycle.');
    source = source.replace(original, replacement);
  }
  return source;
}
