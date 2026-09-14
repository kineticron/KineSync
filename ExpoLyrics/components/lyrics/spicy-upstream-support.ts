/* Minimal host adapters for the verbatim Spicy Lyrics virtualizer. */
export type MaidItem =
  | MutationObserver
  | ResizeObserver
  | Element
  | (() => void)
  | { Destroy?: () => void };

function cleanItem(item: MaidItem): void {
  if (typeof item === "function") item();
  else if (item instanceof MutationObserver || item instanceof ResizeObserver) item.disconnect();
  else if (item instanceof Element) item.remove();
  else if (
    typeof item === "object" &&
    item !== null &&
    "Destroy" in item &&
    typeof item.Destroy === "function"
  ) item.Destroy();
}

export class Maid {
  private items = new Set<MaidItem>();
  private destroyed = false;

  Give<T extends MaidItem>(item: T): T {
    if (this.destroyed) cleanItem(item);
    else this.items.add(item);
    return item;
  }

  Destroy(): void {
    for (const item of this.items) cleanItem(item);
    this.items.clear();
    this.destroyed = true;
  }
}

export default class Logger {
  public isEnabled = false;
  constructor(_prefix?: string) {}
  info(..._args: unknown[]) {}
  debug(..._args: unknown[]) {}
  warn(...args: unknown[]) { console.warn(...args); }
  error(...args: unknown[]) { console.error(...args); }
}
