/** Match the WebView's first significant character and preserve shaping joiners. */
export function spicyIsRtl(text: string) {
  'worklet';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/[\d\s,.;:?!()[\]{}"'\\/<>@#$%^&*_=+-]/.test(char)) continue;
    return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(char);
  }
  return false;
}

export function spicyPaintText(text: string) {
  return text.replace(/[\u200B\u200E\u200F\u2060\uFEFF]/g, '');
}

/** CSS PartOfWord adjacency determines the scale pivot, including RTL overrides. */
export function spicyWordOrigin(joined: boolean, previousJoined: boolean, rtl: boolean) {
  if (rtl) return previousJoined ? 1 : joined ? 0 : 0.5;
  return previousJoined ? joined ? 0.5 : 0 : joined ? 1 : 0.5;
}
