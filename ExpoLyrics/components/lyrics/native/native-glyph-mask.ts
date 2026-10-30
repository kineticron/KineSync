// Fixed Unicode 18.0.0 Extended_Pictographic + Emoji_Presentation snapshot,
// generated from regenerate-unicode-properties 10.3.0, plus U+2661, VS16 and
// keycap. UTF-16 ranges deliberately avoid Unicode property/code-point escapes
// and the u flag: classification must not depend on Hermes' Unicode dataset.
// Includes supplementary emoji, modifiers, regional indicators and reserved
// pictographic ranges: some monochrome/reserved symbols are conservatively
// masked, without changing shaping or timing. Ordinary punctuation/CJK stay
// unmasked. New emoji outside this snapshot need an explicit coverage update.
// This is only a glyph-paint policy, not general emoji detection.
const maskCandidates = /[\xA9\xAE\u203C\u2049\u20E3\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F-\u2661\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26A7\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\uFE0F]|\uD83C[\uDC04\uDC2C-\uDC2F\uDC94-\uDC9F\uDCAF\uDCB0\uDCC0\uDCCF\uDCD0\uDCF6-\uDCFF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDAF-\uDDFF\uDE01-\uDE0F\uDE1A\uDE2F\uDE32-\uDE3A\uDE3C-\uDE3F\uDE49-\uDE5F\uDE66-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5-\uDEE5\uDEE9\uDEEB-\uDEF0\uDEF3-\uDEFF\uDFDC-\uDFF0]|\uD83E[\uDC0C-\uDC0F\uDC48-\uDC4F\uDC5A-\uDC5F\uDC88-\uDC8F\uDCAE\uDCAF\uDCBC-\uDCBF\uDCC2-\uDCCF\uDCD9-\uDCFF\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDDFF\uDE58-\uDE5F\uDE6E-\uDEFF]|\uD83F[\uDC00-\uDFFD]/;

/** Conservative color-font candidates; SkTypeface exposes no color metadata. */
export function needsEmojiMask(grapheme: string): boolean {
  // An explicit text presentation selector takes precedence for this grapheme.
  return !grapheme.includes('\uFE0E') && maskCandidates.test(grapheme);
}
