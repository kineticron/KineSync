/*
 * KineSync standalone host adapter for Spicy Lyrics v6.3.15.
 * Word construction, animator lifecycle and interlude effects are ported from Spikerko/spicy-lyrics @
 * 2a14863f8c29782f9ab3becff2b1360dfb74a4fb (AGPL-3.0).
 * KineSync-specific bridge/selection/translation behavior stays at this boundary.
 */
import "./spicy-webview.css";
import "./spicy-layout.css";
import {
  animate,
  createDotTiming,
  resetSpicyAnimatorState,
  type SpicyLetter,
  type SpicyLyricsType,
  type SpicyRuntimeLine,
  type SpicyWord,
} from "./spicy-upstream-runtime";
import {
  destroyLyricsLayout,
  initLyricsLayout,
  remeasureLyricsLayout,
  noteLyricsUserScroll,
  noteLyricsViewportScroll,
  setLyricsUserTouching,
  releaseLyricsUserScroll,
  resetLyricsScroll,
  scrollToActiveLine,
  getLyricsPlaybackState,
  getVisibleLyricsLines,
  isLyricsScrollAnimating,
} from "./spicy-layout-host";
import { createLyricsFrameLoop } from "./spicy-frame-loop";
import { getSpicyWordJoins } from "./spicy-word-spacing";
import { createSpicyPlaybackClock } from "./spicy-playback-clock";
import { LONG_PAUSE_THRESHOLD_MS, LYRICS_LAYOUT, TOP_LIST_PADDING } from "../../lib/lyrics-layout";
import { LANDSCAPE_TOP_LIST_PADDING, LANDSCAPE_LYRICS_HORIZONTAL_INSET, LANDSCAPE_LYRICS_EDGE_BLEED, LANDSCAPE_LYRIC_TEXT_LANE_WIDTH } from "../../constants/player-layout";
import type { LyricLine } from "../../types/bridge";

type KineSyncSyllable = {
  text?: string;
  startTime?: number;
  endTime?: number;
  isPartOfWord?: boolean;
};

type KineSyncLine = {
  lineStartTime?: number;
  lineEndTime?: number;
  syllables?: KineSyncSyllable[];
  backgroundSyllables?: KineSyncSyllable[];
  spicyBackgrounds?: {
    lineStartTime?: number;
    lineEndTime?: number;
    syllables?: KineSyncSyllable[];
  }[];
  spicyLyricsStartTime?: number;
  backgroundText?: string;
  translatedText?: string;
  backgroundTranslatedText?: string;
  oppositeAligned?: boolean;
};

type LyricsAttribution = {
  source?: string;
  provider?: string;
  community?: boolean;
  maker?: { username?: string; avatar?: string };
  uploader?: { username?: string; avatar?: string };
};

type IncomingMessage = {
  type?: string;
  lines?: KineSyncLine[];
  positionMs?: number;
  previewPositionMs?: number | null;
  isPlaying?: boolean;
  active?: boolean;
  durationMs?: number;
  force?: boolean;
  showTranslatedText?: boolean;
  tapToSeekEnabled?: boolean;
  landscapeMode?: boolean;
  fontScale?: number;
  selectedKeys?: Record<string, boolean>;
  emptyTitle?: string;
  emptySub?: string;
  songwriters?: string[];
  attribution?: LyricsAttribution;
  lastLyricEndTime?: number;
  timingMode?: "karaoke" | "interpolated" | "static" | "unknown";
  autoFollowEnabled?: boolean;
  resumeAutoFollowSignal?: number;
};

const bridgeWindow = window as typeof window & {
  KineSyncLyrics?: { receive: (message: IncomingMessage) => void };
  ReactNativeWebView?: { postMessage: (message: string) => void };
};

const page = document.getElementById("SpicyLyricsPage") as HTMLElement | null;
const scrollRoot = document.getElementById("spicyScrollRoot") as HTMLElement | null;
const scrollViewport = scrollRoot?.parentElement as HTMLElement | null;
const empty = document.getElementById("empty") as HTMLElement | null;
const emptyTitle = document.getElementById("emptyTitle") as HTMLElement | null;
const emptySub = document.getElementById("emptySub") as HTMLElement | null;
const creditsRoot = document.getElementById("spicyCredits") as HTMLElement | null;
const staticLyricsRoot = document.getElementById("staticLyricsRoot") as HTMLElement | null;

let sourceLines: KineSyncLine[] = [];
let runtimeLines: SpicyRuntimeLine[] = [];
let sourceElements = new Map<number, HTMLElement[]>();
let selectedKeys: Record<string, boolean> = {};
const playbackClock = createSpicyPlaybackClock();
let isPlaying = false;
let previewPositionMs: number | null = null;
let durationMs = 0;
let tapToSeekEnabled = true;
let showTranslatedText = true;
let landscapeMode = false;
let fontScale = 1;
let activeSourceIndex = -1;
let autoFollowEnabled = true;
let resumeAutoFollowSignal = 0;
let lastLyricEndTime = 0;
let staticLyricsMode = false;
let currentLyricsType: SpicyLyricsType = "Syllable";
let staticSongwriters: string[] = [];
let staticAttribution: LyricsAttribution | undefined;
let rendererActive = true;
let animationCues: number[] = [];
let longPressTimer = 0;
let pressedTimer = 0;
let pressedElements: HTMLElement[] = [];
let touchStartIndex = -1;
let touchMoved = false;
let longPressTriggered = false;
let pendingForceScroll = true;
let pendingClockReset = true;

function post(payload: unknown) {
  bridgeWindow.ReactNativeWebView?.postMessage(JSON.stringify(payload));
}

function finiteMs(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function sourceKey(line: KineSyncLine) {
  return `${finiteMs(line.lineStartTime)}-${finiteMs(line.lineEndTime)}`;
}

function projectedPosition() {
  if (previewPositionMs !== null && Number.isFinite(previewPositionMs)) {
    return Math.max(0, previewPositionMs);
  }
  const next = playbackClock.position(performance.now());
  return durationMs > 0 ? Math.min(durationMs, next) : next;
}

function getBackgroundSyllables(line: KineSyncLine) {
  if (line.backgroundSyllables?.length) return line.backgroundSyllables;
  const text = String(line.backgroundText || "").trim();
  if (!text) return [];
  return [{ text, startTime: line.lineStartTime, endTime: line.lineEndTime }];
}

function stripZeroWidth(value: string) {
  // Upstream deliberately preserves ZWNJ/ZWJ because they are meaningful in
  // Arabic/Persian/Indic scripts and emoji sequences.
  return value.replace(/[\u200B\u200E\u200F\u2060\uFEFF]/g, "");
}

function isRtl(text: string) {
  if (!text) return false;
  const rtlRegex =
    /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/[\d\s,.;:?!()[\]{}"'\\/<>@#$%^&*_=+-]/.test(char)) continue;
    return rtlRegex.test(char);
  }
  return false;
}

function addSourceElement(sourceIndex: number, element: HTMLElement) {
  const elements = sourceElements.get(sourceIndex) || [];
  elements.push(element);
  sourceElements.set(sourceIndex, elements);
}

function createSpicyWord(
  parent: HTMLElement,
  syllable: KineSyncSyllable,
  index: number,
  siblings: KineSyncSyllable[],
  isBackground: boolean,
): { word: SpicyWord; element: HTMLElement } {
  const text = stripZeroWidth(String(syllable.text || ""));
  const startTime = finiteMs(syllable.startTime);
  const endTime = Math.max(startTime + 1, finiteMs(syllable.endTime, startTime + 1));
  const totalTime = endTime - startTime;
  const letterCapable = text.split("").length > 0 && totalTime >= 1000 && !isRtl(text);
  let word = document.createElement("span");
  let runtimeWord: SpicyWord;

  if (letterCapable) {
    word = document.createElement("div");
    const letters = text.split("");
    const emphasizedEndTime = endTime - 250;
    const letterDuration = (emphasizedEndTime - startTime) / letters.length;
    const runtimeLetters: SpicyLetter[] = [];
    letters.forEach((letterText, letterIndex) => {
      const letter = document.createElement("span");
      letter.textContent = letterText;
      letter.classList.add("letter", "Emphasis");
      if (letterText.trim().length === 0) letter.classList.add("SpaceLetter");
      if (letterIndex === letters.length - 1) letter.classList.add("LastLetterInWord");
      const letterStartTime = startTime + letterIndex * letterDuration;
      letter.style.setProperty("--gradient-position", "-20%");
      letter.style.setProperty("--text-shadow-opacity", "0%");
      letter.style.setProperty("--text-shadow-blur-radius", "4px");
      letter.style.scale = "0.95";
      letter.style.transform = "translateY(calc(var(--DefaultLyricsSize) * 0.02))";
      word.appendChild(letter);
      runtimeLetters.push({
        HTMLElement: letter,
        StartTime: letterStartTime,
        EndTime: letterStartTime + letterDuration,
        TotalTime: letterDuration,
        Emphasis: true,
        BGLetter: isBackground || undefined,
      });
    });
    word.classList.add("letterGroup");
    word.style.setProperty("--text-shadow-opacity", "0%");
    word.style.setProperty("--text-shadow-blur-radius", "4px");
    word.style.scale = "0.95";
    word.style.transform = `translateY(calc(var(--${isBackground ? "font-size" : "DefaultLyricsSize"}) * 0.02))`;
    runtimeWord = {
      HTMLElement: word,
      StartTime: startTime,
      EndTime: emphasizedEndTime,
      TotalTime: emphasizedEndTime - startTime,
      LetterGroup: true,
      Letters: runtimeLetters,
      BGWord: isBackground || undefined,
    };
  } else {
    word.textContent = text;
    word.classList.add("word");
    if (isBackground) word.classList.add("bg-word");
    word.style.setProperty("--gradient-position", isBackground ? "0%" : "-20%");
    word.style.setProperty("--text-shadow-opacity", "0%");
    word.style.setProperty("--text-shadow-blur-radius", "4px");
    word.style.scale = "0.95";
    word.style.transform = `translateY(calc(var(--${isBackground ? "font-size" : "DefaultLyricsSize"}) * 0.01))`;
    runtimeWord = {
      HTMLElement: word,
      StartTime: startTime,
      EndTime: endTime,
      TotalTime: totalTime,
      BGWord: isBackground || undefined,
    };
  }

  if (index === siblings.length - 1) word.classList.add("LastWordInLine");
  else if (syllable.isPartOfWord) word.classList.add("PartOfWord");
  return { word: runtimeWord, element: word };
}

function renderWords(
  lineElement: HTMLElement,
  syllables: KineSyncSyllable[],
  isBackground = false,
): SpicyWord[] {
  const words: SpicyWord[] = [];
  let currentWordGroup: HTMLSpanElement | null = null;
  const joins = getSpicyWordJoins(syllables);
  // All-literal lines (KRC/QRC/YRC trailing spaces) keep the zeroed column
  // gap; flagged lines use upstream gaps, including column-gap when opposite.
  if (syllables.every((syllable) => typeof syllable.isPartOfWord !== "boolean")) {
    lineElement.classList.add("ks-literal-line");
  }
  syllables.forEach((syllable, index, all) => {
    const built = createSpicyWord(lineElement, { ...syllable, isPartOfWord: joins[index] }, index, all, isBackground);
    if (typeof syllable.isPartOfWord !== "boolean") built.element.classList.add("ks-literal-spacing");
    if (joins[index] || (joins[index - 1] && currentWordGroup)) {
      if (!currentWordGroup) {
        currentWordGroup = document.createElement("span");
        currentWordGroup.classList.add("word-group");
        lineElement.appendChild(currentWordGroup);
      }
      currentWordGroup.appendChild(built.element);
      if (!joins[index]) currentWordGroup = null;
    } else {
      currentWordGroup = null;
      lineElement.appendChild(built.element);
    }
    words.push(built.word);
  });
  return words;
}

function appendTranslation(parent: HTMLElement, text: string | undefined) {
  const value = String(text || "").trim();
  if (!showTranslatedText || !value) return;
  const translation = document.createElement("div");
  translation.className = "ks-translation";
  translation.textContent = value;
  parent.appendChild(translation);
}

function createLeadRuntimeLine(line: KineSyncLine, sourceIndex: number): SpicyRuntimeLine {
  const element = document.createElement("div");
  element.classList.add("line");
  element.dataset.sourceIndex = String(sourceIndex);
  if (line.oppositeAligned) element.classList.add("OppositeAligned");
  const syllables = line.syllables || [];
  if (syllables.some((syllable) => isRtl(String(syllable.text || "")))) element.classList.add("rtl");
  const words = renderWords(element, syllables);
  appendTranslation(element, line.translatedText);
  const startTime = finiteMs(line.lineStartTime);
  const endTime = Math.max(startTime + 1, finiteMs(line.lineEndTime, startTime + 1));
  addSourceElement(sourceIndex, element);
  return {
    HTMLElement: element,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    Syllables: { Lead: words },
    sourceIndex,
  };
}

function createBackgroundRuntimeLine(line: KineSyncLine, sourceIndex: number): SpicyRuntimeLine | null {
  const syllables = getBackgroundSyllables(line);
  if (!syllables.length) return null;
  const element = document.createElement("div");
  element.classList.add("line", "bg-line");
  element.dataset.sourceIndex = String(sourceIndex);
  if (line.oppositeAligned) element.classList.add("OppositeAligned");
  if (syllables.some((syllable) => isRtl(String(syllable.text || "")))) element.classList.add("rtl");
  const words = renderWords(element, syllables, true);
  appendTranslation(element, line.backgroundTranslatedText);
  const startTime = finiteMs(syllables[0]?.startTime, line.lineStartTime);
  const endTime = Math.max(
    startTime + 1,
    finiteMs(syllables[syllables.length - 1]?.endTime, line.lineEndTime),
  );
  addSourceElement(sourceIndex, element);
  return {
    HTMLElement: element,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    Syllables: { Lead: words },
    BGLine: true,
    sourceIndex,
  };
}

function createExactSpicyBackgroundRuntimeLine(
  parentLine: KineSyncLine,
  background: NonNullable<KineSyncLine["spicyBackgrounds"]>[number],
  sourceIndex: number,
  translatedText = "",
): SpicyRuntimeLine | null {
  const syllables = Array.isArray(background.syllables) ? background.syllables : [];
  if (!syllables.length) return null;
  const element = document.createElement("div");
  element.classList.add("line", "bg-line");
  element.dataset.sourceIndex = String(sourceIndex);
  if (parentLine.oppositeAligned) element.classList.add("OppositeAligned");
  const words = renderWords(element, syllables, true);
  if (isRtl(syllables.map((syllable) => String(syllable.text || "")).join(""))) {
    element.classList.add("rtl");
  }
  appendTranslation(element, translatedText);
  addSourceElement(sourceIndex, element);
  const startTime = finiteMs(background.lineStartTime);
  const endTime = Math.max(
    startTime + 1,
    finiteMs(background.lineEndTime, startTime + 1),
  );
  return {
    HTMLElement: element,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    Syllables: { Lead: words },
    BGLine: true,
    sourceIndex,
  };
}

function getLineSyncedText(syllables: KineSyncSyllable[]) {
  return stripZeroWidth(syllables.map((syllable) => String(syllable.text || "")).join(""));
}

function createLineLeadRuntimeLine(line: KineSyncLine, sourceIndex: number): SpicyRuntimeLine {
  const element = document.createElement("div");
  const syllables = line.syllables || [];
  const text = getLineSyncedText(syllables);
  element.textContent = text;
  element.classList.add("line");
  element.dataset.sourceIndex = String(sourceIndex);
  if (line.oppositeAligned) element.classList.add("OppositeAligned");
  if (isRtl(text)) element.classList.add("rtl");
  appendTranslation(element, line.translatedText);
  const startTime = finiteMs(line.lineStartTime);
  const endTime = Math.max(startTime + 1, finiteMs(line.lineEndTime, startTime + 1));
  addSourceElement(sourceIndex, element);
  return {
    HTMLElement: element,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    sourceIndex,
  };
}

function createLineBackgroundRuntimeLine(
  line: KineSyncLine,
  sourceIndex: number,
): SpicyRuntimeLine | null {
  const syllables = getBackgroundSyllables(line);
  if (!syllables.length) return null;
  const element = document.createElement("div");
  const text = getLineSyncedText(syllables);
  element.textContent = text;
  element.classList.add("line", "bg-line");
  element.dataset.sourceIndex = String(sourceIndex);
  if (line.oppositeAligned) element.classList.add("OppositeAligned");
  if (isRtl(text)) element.classList.add("rtl");
  appendTranslation(element, line.backgroundTranslatedText);
  const startTime = finiteMs(syllables[0]?.startTime, line.lineStartTime);
  const endTime = Math.max(
    startTime + 1,
    finiteMs(syllables[syllables.length - 1]?.endTime, line.lineEndTime),
  );
  addSourceElement(sourceIndex, element);
  return {
    HTMLElement: element,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    BGLine: true,
    sourceIndex,
  };
}

function createDotRuntimeLine(
  startTime: number,
  endTime: number,
  oppositeAligned = false,
): SpicyRuntimeLine {
  const line = document.createElement("div");
  line.classList.add("line", "musical-line");
  if (oppositeAligned) line.classList.add("OppositeAligned");
  const group = document.createElement("div");
  group.classList.add("dotGroup");
  const words: SpicyWord[] = createDotTiming(startTime, endTime).map(([dotStart, dotEnd]) => {
    const dot = document.createElement("span");
    dot.classList.add("word", "dot");
    dot.textContent = "•";
    group.appendChild(dot);
    return {
      HTMLElement: dot,
      StartTime: dotStart,
      EndTime: dotEnd,
      TotalTime: dotEnd - dotStart,
      Dot: true,
    };
  });
  line.appendChild(group);
  return {
    HTMLElement: line,
    StartTime: startTime,
    EndTime: endTime,
    TotalTime: endTime - startTime,
    Syllables: { Lead: words },
    DotLine: true,
  };
}

function renderSyncedLyrics() {
  if (!scrollRoot || !scrollViewport) return;
  const previousOffset = scrollViewport.scrollTop;
  destroyLyricsLayout();
  scrollRoot.replaceChildren();
  runtimeLines = [];
  sourceElements = new Map();
  const virtualContainer = document.createElement("div");
  virtualContainer.classList.add("KineSyncLyricsRows");
  scrollRoot.appendChild(virtualContainer);

  const firstStart = finiteMs(sourceLines[0]?.lineStartTime);
  const upstreamLyricsStart = sourceLines.find(
    (line) => line.spicyLyricsStartTime !== undefined,
  )?.spicyLyricsStartTime;
  const introStart = finiteMs(upstreamLyricsStart, 0);
  if (
    sourceLines.length &&
    firstStart - introStart >= LONG_PAUSE_THRESHOLD_MS
  ) {
    runtimeLines.push(
      createDotRuntimeLine(
        introStart,
        firstStart,
        Boolean(sourceLines[0]?.oppositeAligned),
      ),
    );
  }

  sourceLines.forEach((line, sourceIndex) => {
    runtimeLines.push(
      currentLyricsType === "Line"
        ? createLineLeadRuntimeLine(line, sourceIndex)
        : createLeadRuntimeLine(line, sourceIndex),
    );
    if (currentLyricsType === "Line") {
      const background = createLineBackgroundRuntimeLine(line, sourceIndex);
      if (background) runtimeLines.push(background);
    } else if (Array.isArray(line.spicyBackgrounds)) {
      line.spicyBackgrounds.forEach((background, backgroundIndex) => {
        const runtimeBackground = createExactSpicyBackgroundRuntimeLine(
          line,
          background,
          sourceIndex,
          backgroundIndex === 0 ? String(line.backgroundTranslatedText || "") : "",
        );
        if (runtimeBackground) runtimeLines.push(runtimeBackground);
      });
    } else {
      const background = createBackgroundRuntimeLine(line, sourceIndex);
      if (background) runtimeLines.push(background);
    }
    const next = sourceLines[sourceIndex + 1];
    const leadEnd = finiteMs(line.lineEndTime);
    const nextStart = finiteMs(next?.lineStartTime);
    if (next && nextStart - leadEnd >= LONG_PAUSE_THRESHOLD_MS) {
      runtimeLines.push(createDotRuntimeLine(leadEnd, nextStart, Boolean(next.oppositeAligned)));
    }
  });

  scrollRoot.classList.toggle("HasDuetLines", sourceLines.some((line) => Boolean(line.oppositeAligned)));
  scrollRoot.classList.toggle(
    "HasRtlLines",
    sourceLines.some((line) =>
      [...(line.syllables || []), ...getBackgroundSyllables(line)].some((syllable) =>
        isRtl(String(syllable.text || "")),
      ),
    ),
  );
  scrollRoot.dataset.lyricsType = currentLyricsType;
  if (creditsRoot) scrollRoot.appendChild(creditsRoot);

  resetSpicyAnimatorState();
  resetLyricsScroll();
  initLyricsLayout(scrollViewport, virtualContainer, runtimeLines, sourceLines as LyricLine[], scheduleFrame);
  animationCues = [...new Set(runtimeLines.flatMap((line) =>
    [line.StartTime, line.EndTime, line.EndTime - 500]))].sort((a, b) => a - b);
  if (!autoFollowEnabled) scrollViewport.scrollTop = previousOffset;
  updateSelection();
  pendingForceScroll = true;
}

function getStaticLineText(line: KineSyncLine) {
  return stripZeroWidth((line.syllables || []).map((s) => String(s.text || "")).join(""));
}

function appendCreditsContent(
  container: HTMLElement,
  songwriters: string[] = [],
  attribution?: LyricsAttribution,
) {
  const append = (label: string, value: string) => {
    const row = document.createElement("div");
    if (label) {
      const strong = document.createElement("span");
      strong.className = "kinesync-credits-strong";
      strong.textContent = label;
      row.appendChild(strong);
    }
    row.appendChild(document.createTextNode(value));
    container.appendChild(row);
  };
  const appendProfile = (label: string, profile: { username?: string; avatar?: string }) => {
    if (!profile.username) return;
    const row = document.createElement("div");
    row.className = "kinesync-credits-profile";
    const text = document.createElement("span");
    const strong = document.createElement("span");
    strong.className = "kinesync-credits-strong";
    strong.textContent = label;
    text.append(strong, document.createTextNode(`@${profile.username}`));
    row.appendChild(text);
    if (profile.avatar) {
      const avatar = document.createElement("img");
      avatar.className = "kinesync-credits-avatar";
      avatar.src = profile.avatar;
      avatar.alt = `${profile.username}'s avatar`;
      avatar.onerror = () => avatar.remove();
      row.appendChild(avatar);
    }
    container.appendChild(row);
  };
  if (songwriters.length) append("Written By: ", songwriters.join(", "));
  if (attribution?.provider) append("Provided By: ", attribution.provider);
  if (attribution?.community) append("", "These lyrics have been provided by the Spicy Lyrics community");
  if (attribution?.maker?.username) appendProfile("Made By: ", attribution.maker);
  if (attribution?.uploader?.username) {
    appendProfile(attribution.maker?.username ? "Uploaded By: " : "Made By: ", attribution.uploader);
  }
}

function renderCredits(songwriters: string[] = [], attribution?: LyricsAttribution, endTime = 0) {
  if (!creditsRoot) return;
  creditsRoot.replaceChildren();
  lastLyricEndTime = finiteMs(endTime);
  creditsRoot.hidden = !songwriters.length && !attribution;
  if (!creditsRoot.hidden) appendCreditsContent(creditsRoot, songwriters, attribution);
}

function renderStaticLyrics() {
  if (!staticLyricsRoot) return;
  const previousOffset = staticLyricsRoot.scrollTop;
  destroyLyricsLayout();
  scrollRoot?.replaceChildren();
  staticLyricsRoot.replaceChildren();
  runtimeLines = [];
  sourceElements = new Map();

  sourceLines.forEach((line, sourceIndex) => {
    const text = getStaticLineText(line);
    const row = document.createElement("div");
    row.classList.add("static-lyrics-line");
    row.dataset.sourceIndex = String(sourceIndex);
    row.textContent = text;
    if (isRtl(text)) row.classList.add("rtl");
    if (showTranslatedText && line.translatedText) {
      const translation = document.createElement("div");
      translation.className = "static-lyrics-translation";
      translation.textContent = line.translatedText;
      row.appendChild(translation);
    }
    // KineSync can carry a compatibility background/translation even for a
    // static source. Spicy itself has no static BG-row type, so keep it as a
    // host extension inside the same upstream-style `.line.static` row.
    const backgroundText = getBackgroundSyllables(line)
      .map((syllable) => String(syllable.text || ""))
      .join("")
      .trim();
    if (backgroundText) {
      const background = document.createElement("div");
      background.className = "static-lyrics-background";
      background.textContent = backgroundText;
      if (showTranslatedText && line.backgroundTranslatedText) {
        const translated = document.createElement("div");
        translated.className = "static-lyrics-background-translation";
        translated.textContent = line.backgroundTranslatedText;
        background.appendChild(translated);
      }
      row.appendChild(background);
    }
    addSourceElement(sourceIndex, row);
    staticLyricsRoot.appendChild(row);
  });

  renderCredits(staticSongwriters, staticAttribution, 0);
  if (creditsRoot) staticLyricsRoot.appendChild(creditsRoot);
  staticLyricsRoot.scrollTop = previousOffset;
  resetLyricsScroll();
}

function updateSelection() {
  sourceLines.forEach((line, index) => {
    const selected = Boolean(selectedKeys[sourceKey(line)]);
    sourceElements.get(index)?.forEach((element) => element.classList.toggle("ks-selected", selected));
  });
}

function showEmpty(title: string, sub: string) {
  if (!empty) return;
  empty.hidden = sourceLines.length > 0;
  if (emptyTitle) emptyTitle.textContent = title;
  if (emptySub) emptySub.textContent = sub;
}

function applyPageOptions() {
  page?.classList.toggle("landscape", landscapeMode);
  page?.style.setProperty("--ks-font-scale", String(fontScale));
  const metrics: Record<string, string> = {
    "--ks-font-size": `${LYRICS_LAYOUT.fontSize * LYRICS_LAYOUT.activeScale}px`,
    "--ks-line-height": `${LYRICS_LAYOUT.lineHeight * LYRICS_LAYOUT.activeScale}px`,
    "--ks-bg-scale": String(LYRICS_LAYOUT.backgroundScale),
    "--ks-top-padding": `${landscapeMode ? LANDSCAPE_TOP_LIST_PADDING : TOP_LIST_PADDING}px`,
    "--ks-list-inset": `${landscapeMode ? LANDSCAPE_LYRICS_HORIZONTAL_INSET + LANDSCAPE_LYRICS_EDGE_BLEED : LYRICS_LAYOUT.listInset}px`,
    "--ks-inner-inset": `${landscapeMode ? LYRICS_LAYOUT.landscapeInnerInset : LYRICS_LAYOUT.innerInset}px`,
    "--ks-text-lane": landscapeMode ? LANDSCAPE_LYRIC_TEXT_LANE_WIDTH : LYRICS_LAYOUT.textLane,
    "--ks-row-height": `${LYRICS_LAYOUT.rowMinHeight}px`,
    "--ks-row-padding": `${LYRICS_LAYOUT.rowPadding + LYRICS_LAYOUT.pressPadding}px`,
  };
  for (const [name, value] of Object.entries(metrics)) page?.style.setProperty(name, value);
  staticLyricsRoot?.classList.toggle("landscape", landscapeMode);
  staticLyricsRoot?.style.setProperty("--ks-font-scale", String(fontScale));
}

function computeActiveSource(position: number) {
  const next = getLyricsPlaybackState(position).activeLineStartIndex;
  if (next !== activeSourceIndex) {
    activeSourceIndex = next;
    post({ type: "activeLineChange", index: activeSourceIndex });
  }
}

function setLyrics(message: IncomingMessage) {
  pendingClockReset = true;
  sourceLines = Array.isArray(message.lines) ? message.lines : [];
  staticLyricsMode = message.timingMode === "static";
  // KineSync intentionally keeps interpolated/line-synced sources on the
  // syllable runtime. They arrive as timed synthetic syllables and should use
  // the same word/spring/gradient machinery as karaoke instead of Spicy's
  // separate direct-text Line renderer.
  currentLyricsType = "Syllable";
  staticSongwriters = Array.isArray(message.songwriters) ? message.songwriters : [];
  staticAttribution = message.attribution;
  activeSourceIndex = -1;
  if (scrollRoot) scrollRoot.hidden = false;
  if (page) page.hidden = staticLyricsMode;
  if (staticLyricsRoot) staticLyricsRoot.hidden = !staticLyricsMode;
  if (staticLyricsMode) {
    renderStaticLyrics();
    staticLyricsRoot?.scrollTo({ top: 0, behavior: "auto" });
    post({ type: "activeLineChange", index: -1 });
  } else {
    renderCredits(message.songwriters || [], message.attribution, finiteMs(message.lastLyricEndTime));
    renderSyncedLyrics();
  }
  showEmpty(message.emptyTitle || "No synced lyrics yet", message.emptySub || "");
  scheduleFrame();
}

function applyOptions(message: IncomingMessage) {
  const translationsChanged = showTranslatedText !== Boolean(message.showTranslatedText);
  const nextLandscape = Boolean(message.landscapeMode);
  const layoutChanged = landscapeMode !== nextLandscape || fontScale !== finiteMs(message.fontScale, 1);
  showTranslatedText = Boolean(message.showTranslatedText);
  tapToSeekEnabled = Boolean(message.tapToSeekEnabled);
  landscapeMode = nextLandscape;
  fontScale = finiteMs(message.fontScale, 1);
  selectedKeys = message.selectedKeys || {};
  if (typeof message.autoFollowEnabled === "boolean") autoFollowEnabled = message.autoFollowEnabled;
  if (
    typeof message.resumeAutoFollowSignal === "number" &&
    message.resumeAutoFollowSignal !== resumeAutoFollowSignal
  ) {
    resumeAutoFollowSignal = message.resumeAutoFollowSignal;
    releaseLyricsUserScroll();
    autoFollowEnabled = true;
    pendingForceScroll = true;
    pendingClockReset = true;
  }
  applyPageOptions();
  if ((translationsChanged || layoutChanged) && sourceLines.length) {
    if (staticLyricsMode) renderStaticLyrics();
    else renderSyncedLyrics();
  } else if (layoutChanged && !staticLyricsMode) {
    remeasureLyricsLayout();
  }
  updateSelection();
  scheduleFrame();
}

function sync(message: IncomingMessage) {
  const next = finiteMs(message.positionMs);
  const force = pendingClockReset || Boolean(message.force) || Math.abs(projectedPosition() - next) > 1000;
  playbackClock.sync(next, Boolean(message.isPlaying), performance.now(), force || previewPositionMs !== null);
  pendingClockReset = false;
  isPlaying = Boolean(message.isPlaying);
  durationMs = finiteMs(message.durationMs);
  previewPositionMs = message.previewPositionMs == null ? null : finiteMs(message.previewPositionMs);
  if (typeof message.active === "boolean") rendererActive = message.active;
  if (force) pendingForceScroll = true;
  updateSuspension();
}

function setAutoFollow(enabled: boolean) {
  if (autoFollowEnabled === enabled) return;
  autoFollowEnabled = enabled;
  if (enabled) pendingForceScroll = true;
  post({ type: "autoFollowChange", enabled });
}

function sourceIndexFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return -1;
  const line = target.closest<HTMLElement>(".line[data-source-index]");
  const index = Number(line?.dataset.sourceIndex ?? -1);
  return Number.isInteger(index) ? index : -1;
}

function setPressed(index: number) {
  window.clearTimeout(pressedTimer);
  pressedElements.forEach((element) => element.classList.remove("ks-pressed"));
  pressedElements = sourceElements.get(index) ?? [];
  pressedElements.forEach((element) => element.classList.add("ks-pressed"));
  pressedTimer = window.setTimeout(() => {
    pressedElements.forEach((element) => element.classList.remove("ks-pressed"));
    pressedElements = [];
  }, 420);
}

scrollViewport?.addEventListener("click", (event) => {
  if (staticLyricsMode) return;
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  const index = sourceIndexFromTarget(event.target);
  if (index < 0 || index >= sourceLines.length) return;
  setPressed(index);
  if (tapToSeekEnabled) {
    releaseLyricsUserScroll();
    setAutoFollow(true);
    post({ type: "linePress", index });
  }
});

scrollViewport?.addEventListener("contextmenu", (event) => {
  if (staticLyricsMode) return;
  const index = sourceIndexFromTarget(event.target);
  if (index < 0 || index >= sourceLines.length) return;
  event.preventDefault();
  setPressed(index);
  post({ type: "lineLongPress", index });
});

scrollViewport?.addEventListener("touchstart", (event) => {
  if (staticLyricsMode) return;
  setLyricsUserTouching(true);
  post({ type: "userInteraction" });
  scheduleFrame();
  touchMoved = false;
  longPressTriggered = false;
  touchStartIndex = sourceIndexFromTarget(event.target);
  window.clearTimeout(longPressTimer);
  if (touchStartIndex >= 0) {
    longPressTimer = window.setTimeout(() => {
      if (!touchMoved && touchStartIndex >= 0) {
        longPressTriggered = true;
        setPressed(touchStartIndex);
        post({ type: "lineLongPress", index: touchStartIndex });
      }
    }, 540);
  }
}, { passive: true });

function noteUserScroll() {
  touchMoved = true;
  window.clearTimeout(longPressTimer);
  if (staticLyricsMode) return;
  noteLyricsUserScroll();
  scheduleFrame();
}

scrollViewport?.addEventListener("touchmove", noteUserScroll, { passive: true });
function endLyricsTouch() {
  window.clearTimeout(longPressTimer);
  touchStartIndex = -1;
  setLyricsUserTouching(false);
  scheduleFrame();
}
scrollViewport?.addEventListener("touchend", endLyricsTouch, { passive: true });
scrollViewport?.addEventListener("touchcancel", endLyricsTouch, { passive: true });
scrollViewport?.addEventListener("wheel", noteUserScroll, { passive: true });
// Scroll also wakes a paused renderer during touch momentum/programmatic seeks.
scrollViewport?.addEventListener("scroll", () => {
  noteLyricsViewportScroll();
  scheduleFrame();
}, { passive: true });

creditsRoot?.addEventListener("click", () => {
  if (lastLyricEndTime <= 0) return;
  releaseLyricsUserScroll();
  setAutoFollow(true);
  post({ type: "creditsPress", positionMs: lastLyricEndTime });
});

function scheduleFrame() {
  frameLoop.wake();
}

function frame() {
  if (!staticLyricsMode && sourceLines.length > 0) {
    const position = projectedPosition();
    if (scrollViewport) {
      scrollToActiveLine(
        position,
        autoFollowEnabled,
        pendingForceScroll,
        setAutoFollow,
      );
    }
    computeActiveSource(position);
    const visible = getVisibleLyricsLines();
    const clockRunning = isPlaying && previewPositionMs === null &&
      (durationMs <= 0 || position < durationMs);
    const springsMoving = animate(visible, position, currentLyricsType,
      getLyricsPlaybackState(position).focusLineIndex, clockRunning);
    pendingForceScroll = false;
    if (springsMoving || isLyricsScrollAnimating()) return 0;
    if (clockRunning) {
      if (visible.some((line) => !line.HTMLElement.hidden && position >= line.StartTime && position < line.EndTime)) return 0;
      // Sleep through gaps/offscreen playback, waking exactly at the next
      // timeline boundary (including the native 500ms early dot exit).
      let low = 0;
      let high = animationCues.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (animationCues[mid] <= position) low = mid + 1;
        else high = mid;
      }
      if (low < animationCues.length) return animationCues[low] - position;
    }
  }
  return null;
}

const frameLoop = createLyricsFrameLoop({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (id) => window.clearTimeout(id),
  render: frame,
});

function updateSuspension() {
  const suspended = !rendererActive || document.visibilityState === "hidden";
  if (suspended) {
    window.clearTimeout(longPressTimer);
    touchStartIndex = -1;
    releaseLyricsUserScroll();
  }
  frameLoop.setSuspended(suspended);
}

document.addEventListener("visibilitychange", () => {
  pendingForceScroll = true;
  updateSuspension();
});

// Recompute native row anchors when the viewport changes.
const resetScrollAnchor = () => {
  resetLyricsScroll();
  pendingForceScroll = true;
  scheduleFrame();
};
window.addEventListener("focus", resetScrollAnchor);
window.addEventListener("resize", resetScrollAnchor);

const lyricsContent = scrollRoot?.closest<HTMLElement>(".LyricsContent");
if (lyricsContent) {
  const lyricsContentObserver = new ResizeObserver(resetScrollAnchor);
  lyricsContentObserver.observe(lyricsContent);
}

bridgeWindow.KineSyncLyrics = {
  receive(message: IncomingMessage) {
    if (!message || typeof message !== "object") return;
    if (message.type === "setLyrics") setLyrics(message);
    else if (message.type === "options") applyOptions(message);
    else if (message.type === "sync") sync(message);
    else if (message.type === "visibility") {
      rendererActive = message.active !== false;
      updateSuspension();
    }
  },
};

applyPageOptions();
post({ type: "ready" });
