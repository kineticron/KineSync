/**
 * The share card, drawn with Skia's imperative API so the same code paints the
 * on-screen preview, the PNG and every video frame. Layout and the static
 * parts (blurred artwork, header, footer) are made once in `prepareCard`;
 * `drawCard` only paints the lyrics for a given song time.
 *
 * The card is as tall as its content (header, lyrics, footer), up to 9:16.
 * Animated videos draw each word with the player's Spicy motion (lift, scale,
 * glow, letter waves on held words), stepped frame by frame.
 */
import {
  ClipOp, Skia, TextAlign, TileMode,
  type SkCanvas, type SkImage, type SkParagraph, type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import { drawVoice, shapeGlyphWords, type PictureWord, type ShapedGlyphWord } from '@/components/lyrics/native/native-glyph-picture';
import { buildNativeVoice, type NativePaintWord, type NativeVoice } from '@/components/lyrics/native/native-lyrics-model';
import { clamp01 } from '@/components/lyrics/native/reference-motion';
import { advanceReferenceWordMotion, initialWordSpringState, type WordSpringState } from '@/components/lyrics/native/reference-word-motion';
import { wrapSpicyText } from '@/components/lyrics/native/spicy-native-layout';
import { lineGlow, wordProgress, type ShareLine } from '@/lib/share/share-timeline';
import type { LyricSyllable } from '@/types/bridge';

export type ShareCardInput = {
  width: number;
  /** The tallest the card may be (9:16); it is only as tall as its content. */
  maxHeight: number;
  art: SkImage | null;
  logo: SkImage | null;
  title: string;
  artist: string;
  lines: ShareLine[];
  fonts: SkTypefaceFontProvider;
  /** 'picture': every line lit. 'video': the lines stay put and light up word by word, top to bottom. */
  mode: 'picture' | 'video';
  /** Video only: words move like the player's Spicy lyrics instead of a plain highlight. */
  animated?: boolean;
};

/** A voice (main line or ad-lib) shaped like the player's Spicy renderer, with its word springs. */
type AnimatedVoice = {
  words: ShapedGlyphWord[];
  states: WordSpringState[];
  lastTime: number;
  start: number;
  end: number;
  fontSize: number;
  background: boolean;
  height: number;
};
type PreparedLine = {
  line: ShareLine;
  main: SkParagraph;
  voice?: AnimatedVoice;
  adLibVoice?: { voice: AnimatedVoice; y: number };
  extras: { paragraph: SkParagraph; y: number }[];
  top: number;
  height: number;
};
export type PreparedCard = {
  width: number;
  height: number;
  mode: 'picture' | 'video';
  background: SkImage;
  area: { top: number; left: number };
  items: PreparedLine[];
};

const FAMILY = ['SF Pro Display'];
const DIM = 0.3;
/** A line already sung stays half lit, so the highlight reads as moving down the card. */
const SUNG = 0.6;
/** drawVoice's AMLL-only inputs; the Spicy path does not read them. */
const LINE_MOTION = { scale: 1, velocity: 0, bright: 1, dark: 0.4 };
const FLOAT_CLOCK = { active: false, releasePosition: -1, elapsed: 0 };

function paragraph(fonts: SkTypefaceFontProvider, text: string, width: number, size: number, weight: number,
  color = 'white', { maxLines, align = TextAlign.Left }: { maxLines?: number; align?: TextAlign } = {}) {
  const built = Skia.ParagraphBuilder.Make({
    textAlign: align, ...(maxLines ? { maxLines, ellipsis: '…' } : {}),
    textStyle: { fontFamilies: FAMILY, fontSize: size, fontStyle: { weight }, color: Skia.Color(color), heightMultiplier: 1.16, halfLeading: true },
  }, fonts).addText(text).build();
  built.layout(width);
  return built;
}

/**
 * Shape a voice the way the player's Spicy renderer does (native-skia-voice):
 * Spicy word gaps, Spicy wrapping, then per-word and per-letter glyph slices.
 */
function shapeVoice(fonts: SkTypefaceFontProvider, voice: NativeVoice, width: number, fontSize: number, background: boolean): AnimatedVoice {
  const weight = background ? 500 : 700;
  const lineHeight = fontSize * 1.2;
  const style = {
    textAlign: TextAlign.Left,
    strutStyle: { strutEnabled: true, forceStrutHeight: true, halfLeading: true, fontFamilies: FAMILY, fontSize,
      fontStyle: { weight }, heightMultiplier: lineHeight / fontSize },
    textStyle: { fontFamilies: FAMILY, fontSize, fontStyle: { weight }, color: Skia.Color('white'),
      heightMultiplier: lineHeight / fontSize, halfLeading: true },
  };
  const make = (text: string, words: NativePaintWord[]) => {
    const builder = Skia.ParagraphBuilder.Make(style, fonts);
    if (words.some((word) => word.gapAfter)) {
      const probe = Skia.ParagraphBuilder.Make(style, fonts).addText('0 ').build();
      probe.layout(1000);
      const ch = probe.getRectsForRange(0, 1).reduce((sum, rect) => sum + rect.width, 0);
      const space = probe.getRectsForRange(1, 2).reduce((sum, rect) => sum + rect.width, 0);
      let cursor = 0;
      for (const word of words) if (word.gapAfter) {
        const gap = word.offset + word.text.length;
        builder.addText(text.slice(cursor, gap));
        builder.pushStyle({ ...style.textStyle, letterSpacing: ch * 0.32 - space }).addText(' ').pop();
        cursor = gap + 1;
      }
      builder.addText(text.slice(cursor));
    } else builder.addText(text);
    return builder.build();
  };
  const unwrapped = make(voice.paintText, voice.paintWords);
  unwrapped.layout(100000);
  const wrapped = wrapSpicyText(voice.paintText, voice.paintWords, width, (start, end) =>
    unwrapped.getRectsForRange(start, end).reduce((sum, rect) => sum + rect.width, 0));
  const built = make(wrapped.text, wrapped.words);
  built.layout(width);
  let before = 0;
  const words: PictureWord[] = wrapped.words.map((word) => {
    const rects = built.getRectsForRange(word.offset, word.offset + word.text.length + Number(!!word.gapAfter));
    let offset = word.offset;
    const letters = word.letters.map((letter) => { const start = offset; offset += letter.length; return built.getRectsForRange(start, offset); });
    const wordWidth = rects.reduce((sum, rect) => sum + rect.width, 0);
    const shaped = { word, rects, letters, width: wordWidth, before };
    before += wordWidth;
    return shaped;
  });
  const glyphWords = shapeGlyphWords(built, words, true);
  return { words: glyphWords, states: glyphWords.map((word) => initialWordSpringState(word.word)), lastTime: -1,
    start: voice.start, end: voice.end, fontSize, background, height: built.getHeight() };
}

const voiceFrom = (syllables: LyricSyllable[]) => {
  const timed = syllables.filter((syllable) => String(syllable.text || '').trim());
  if (timed.length < 2) return null;
  const start = Math.min(...timed.map((syllable) => syllable.startTime));
  const end = Math.max(...timed.map((syllable) => syllable.endTime));
  return buildNativeVoice(syllables, start, end, 'spicy');
};

/** Artwork scaled to cover the box, centered. */
function coverRect(image: SkImage, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / image.width(), h / image.height());
  const sw = w / scale;
  const sh = h / scale;
  return { src: Skia.XYWHRect((image.width() - sw) / 2, (image.height() - sh) / 2, sw, sh), dst: Skia.XYWHRect(x, y, w, h) };
}

/** Header and footer geometry, in card pixels. */
function frame(width: number) {
  const s = width / 1080;
  const pad = 72 * s;
  const cover = 150 * s;
  const headerTop = 96 * s;
  const logo = 60 * s;
  const footerBottom = 64 * s;
  return { s, pad, cover, headerTop, logo, footerBottom,
    lyricsTop: headerTop + cover + 64 * s,
    /** From the last lyric line to the card's bottom edge. */
    footerSpace: 72 * s + logo + footerBottom };
}

/** Blurred artwork (or a dark gradient), the header and the footer: everything that never moves. */
function drawBackdrop(canvas: SkCanvas, input: ShareCardInput, height: number) {
  const { width, art, logo, fonts } = input;
  const { s, pad, cover, headerTop, logo: logoSize, footerBottom } = frame(width);
  const paint = Skia.Paint();
  if (art) {
    const blurred = Skia.Paint();
    blurred.setImageFilter(Skia.ImageFilter.MakeBlur(70 * s, 70 * s, TileMode.Clamp, null));
    const side = Math.max(width, height) * 1.3;
    const { src, dst } = coverRect(art, (width - side) / 2, (height - side) / 2, side, side);
    canvas.drawImageRect(art, src, dst, blurred);
    paint.setColor(Skia.Color('rgba(0,0,0,0.42)'));
    canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);
  }
  const shade = Skia.Paint();
  shade.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 0, y: height },
    art ? [Skia.Color('rgba(0,0,0,0.25)'), Skia.Color('rgba(0,0,0,0.05)'), Skia.Color('rgba(0,0,0,0.6)')]
      : [Skia.Color('#1F2A36'), Skia.Color('#121820'), Skia.Color('#07090C')], [0, 0.4, 1], TileMode.Clamp));
  canvas.drawRect(Skia.XYWHRect(0, 0, width, height), shade);

  // Header: cover, title and artist.
  if (art) {
    canvas.save();
    canvas.clipRRect(Skia.RRectXY(Skia.XYWHRect(pad, headerTop, cover, cover), 18 * s, 18 * s), ClipOp.Intersect, true);
    const { src, dst } = coverRect(art, pad, headerTop, cover, cover);
    canvas.drawImageRect(art, src, dst, Skia.Paint());
    canvas.restore();
  }
  const textLeft = art ? pad + cover + 34 * s : pad;
  const textWidth = width - textLeft - pad;
  const title = paragraph(fonts, input.title || 'Unknown song', textWidth, 46 * s, 700, 'white', { maxLines: 2 });
  const artist = paragraph(fonts, input.artist || '', textWidth, 36 * s, 400, 'rgba(255,255,255,0.72)', { maxLines: 1 });
  const block = title.getHeight() + 6 * s + artist.getHeight();
  const blockTop = headerTop + Math.max(0, (cover - block) / 2);
  title.paint(canvas, textLeft, blockTop);
  artist.paint(canvas, textLeft, blockTop + title.getHeight() + 6 * s);

  // Footer, bottom left: the app icon and its name.
  const logoTop = height - footerBottom - logoSize;
  let nameLeft = pad;
  if (logo) {
    canvas.save();
    canvas.clipRRect(Skia.RRectXY(Skia.XYWHRect(pad, logoTop, logoSize, logoSize), 14 * s, 14 * s), ClipOp.Intersect, true);
    canvas.drawImageRect(logo, Skia.XYWHRect(0, 0, logo.width(), logo.height()), Skia.XYWHRect(pad, logoTop, logoSize, logoSize), Skia.Paint());
    canvas.restore();
    nameLeft = pad + logoSize + 18 * s;
  }
  const name = paragraph(fonts, 'KineSync', width - nameLeft - pad, 32 * s, 700, 'rgba(255,255,255,0.8)');
  name.paint(canvas, nameLeft, logoTop + (logoSize - name.getHeight()) / 2);
}

function layoutLines(input: ShareCardInput, size: number, width: number, s: number) {
  const animate = input.mode === 'video' && input.animated;
  let y = 0;
  return input.lines.map((line) => {
    const main = paragraph(input.fonts, line.text, width, size, 800);
    const extras: PreparedLine['extras'] = [];
    const leadVoice = animate && line.wordSynced ? voiceFrom(line.syllables) : null;
    const voice = leadVoice ? shapeVoice(input.fonts, leadVoice, width, size, false) : undefined;
    let height = voice ? voice.height : main.getHeight();
    let adLibVoice: PreparedLine['adLibVoice'];
    const adLibSource = voice && line.adLibSyllables ? voiceFrom(line.adLibSyllables) : null;
    if (adLibSource) {
      adLibVoice = { voice: shapeVoice(input.fonts, adLibSource, width, size * 0.62, true), y: height + 6 * s };
      height += 6 * s + adLibVoice.voice.height;
    }
    for (const [text, scale, weight] of [[adLibVoice ? undefined : line.adLib, 0.62, 600], [line.translation, 0.56, 500]] as const) {
      if (!text) continue;
      const extra = paragraph(input.fonts, text, width, size * scale, weight);
      extras.push({ paragraph: extra, y: height + 6 * s });
      height += 6 * s + extra.getHeight();
    }
    const item: PreparedLine = { line, main, voice, adLibVoice, extras, top: y, height };
    y += height + size * 0.5;
    return item;
  });
}

const roundUp16 = (value: number) => Math.ceil(value / 16) * 16;

export function prepareCard(input: ShareCardInput): PreparedCard | null {
  const { width, maxHeight } = input;
  const { s, pad, lyricsTop, footerSpace } = frame(width);
  const textWidth = width - pad * 2;
  const room = maxHeight - lyricsTop - footerSpace;
  // Every picked line stays on the card: shrink until they fit, right under the header.
  let items = layoutLines(input, 72 * s, textWidth, s);
  for (let size = 68 * s; size >= 36 * s; size -= 4 * s) {
    const last = items.at(-1);
    if (!last || last.top + last.height <= room) break;
    items = layoutLines(input, size, textWidth, s);
  }
  const last = items.at(-1);
  // As tall as the content; a multiple of 16 so every video encoder takes it.
  const height = Math.min(maxHeight, roundUp16(lyricsTop + (last ? last.top + last.height : 0) + footerSpace));
  const surface = Skia.Surface.Make(width, height);
  if (!surface) return null;
  drawBackdrop(surface.getCanvas(), input, height);
  surface.flush();
  const background = surface.makeImageSnapshot();
  return { width, height, mode: input.mode, background, area: { top: lyricsTop, left: pad }, items };
}

/** The sung part of a line as clip rectangles: whole words, and the sung share of the word in progress. */
function sungPath(item: PreparedLine, time: number, x: number, y: number) {
  const path = Skia.Path.Make();
  for (const word of item.line.words) {
    const progress = wordProgress(word, time);
    if (progress <= 0) continue;
    const rects = item.main.getRectsForRange(word.from, word.to);
    const total = rects.reduce((sum, rect) => sum + rect.width, 0);
    let left = total * progress;
    for (const rect of rects) {
      if (left <= 0) break;
      const w = Math.min(rect.width, left);
      path.addRect(Skia.XYWHRect(x + rect.x - 2, y + rect.y - 4, w + 4, rect.height + 8));
      left -= w;
    }
  }
  return path;
}

function withAlpha(canvas: SkCanvas, alpha: number, draw: () => void) {
  if (alpha <= 0.001) return;
  const paint = Skia.Paint();
  paint.setAlphaf(Math.min(1, alpha));
  canvas.saveLayer(paint);
  draw();
  canvas.restore();
}

/**
 * One voice with the player's Spicy word motion. The springs step by the time
 * since the last frame (exactly 1/30 s in an exported video); jumping back,
 * as the looping preview does, snaps them like a seek in the player.
 */
function drawAnimatedVoice(canvas: SkCanvas, voice: AnimatedVoice, time: number, x: number, y: number) {
  const dt = voice.lastTime < 0 ? 0 : Math.min(0.064, Math.max(0, (time - voice.lastTime) / 1000));
  const next = voice.words.map((word, index) => advanceReferenceWordMotion(word.word, voice.states[index], time, dt));
  voice.states = next.map((step) => step.state);
  voice.lastTime = time;
  const active = time >= voice.start && time <= voice.end;
  // The player fades a voice in and out over 200 ms around its active time.
  const opacity = active ? 0.51 + 0.49 * clamp01((time - voice.start) / 200)
    : time > voice.end ? 1 - 0.503 * clamp01((time - voice.end) / 200) : 0.51;
  withAlpha(canvas, opacity, () => {
    canvas.save();
    canvas.translate(x, y);
    drawVoice(canvas, voice.words, next.map((step) => step.motion), time, active, true, voice.background,
      voice.fontSize, voice.end, LINE_MOTION, FLOAT_CLOCK);
    canvas.restore();
  });
}

/**
 * Paint the card at song time `time` (video), or with every line lit
 * (`time` null, the picture).
 */
export function drawCard(canvas: SkCanvas, card: PreparedCard, time: number | null) {
  canvas.drawImage(card.background, 0, 0);
  const { top, left } = card.area;
  if (time == null || card.mode === 'picture') {
    for (const item of card.items) {
      item.main.paint(canvas, left, top + item.top);
      for (const extra of item.extras) withAlpha(canvas, 0.7, () => extra.paragraph.paint(canvas, left, top + item.top + extra.y));
    }
    return;
  }
  // Video: the lines stay where they are; each lights up word by word as it is
  // sung, then stays half lit, so the highlight moves down the card.
  for (const item of card.items) {
    const y = top + item.top;
    const started = time >= item.line.start;
    const lit = started ? lineGlow(item.line, time) + (1 - lineGlow(item.line, time)) * SUNG : 0;
    if (item.voice) {
      drawAnimatedVoice(canvas, item.voice, time, left, y);
      if (item.adLibVoice) drawAnimatedVoice(canvas, item.adLibVoice.voice, time, left, y + item.adLibVoice.y);
    } else {
      withAlpha(canvas, DIM, () => item.main.paint(canvas, left, y));
      if (lit > 0) {
        canvas.save();
        if (item.line.wordSynced) canvas.clipPath(sungPath(item, time, left, y), ClipOp.Intersect, true);
        withAlpha(canvas, lit, () => item.main.paint(canvas, left, y));
        canvas.restore();
      }
    }
    for (const extra of item.extras) {
      withAlpha(canvas, DIM + (0.7 - DIM) * (started ? lit : 0), () => extra.paragraph.paint(canvas, left, y + extra.y));
    }
  }
}

/** A finished frame as an image (PNG export). */
export function renderCardImage(card: PreparedCard, time: number | null) {
  const surface = Skia.Surface.Make(card.width, card.height);
  if (!surface) return null;
  drawCard(surface.getCanvas(), card, time);
  surface.flush();
  return surface.makeImageSnapshot();
}
