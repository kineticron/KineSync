declare module 'hyphen/*' {
  /** Liang hyphenation with that language's TeX patterns. */
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
}
