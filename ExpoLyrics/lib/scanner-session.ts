/** Owns scanner callbacks and named delays across permission, modal and save work. */
export class ScannerSession {
  private generation = 0;
  private active = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  begin() { this.close(); this.active = true; return this.generation; }
  current() { return this.active ? this.generation : null; }
  isCurrent(run: number | null) { return run !== null && this.active && run === this.generation; }
  close() {
    this.generation++;
    this.active = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  cancel(key: string) {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }
  schedule(run: number | null, key: string, callback: () => void, ms: number) {
    if (!this.isCurrent(run) || this.timers.has(key)) return;
    const timer = setTimeout(() => {
      if (this.timers.get(key) !== timer) return;
      this.timers.delete(key);
      if (this.isCurrent(run)) callback();
    }, ms);
    this.timers.set(key, timer);
  }
}
