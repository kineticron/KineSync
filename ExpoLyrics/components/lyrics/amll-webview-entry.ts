import {
  LayoutAlignAnchor,
  LyricPlayer,
  type LyricLine,
  type LyricLineMouseEvent,
} from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";

type KineSyncSyllable = {
  text?: string;
  startTime?: number;
  endTime?: number;
};

type KineSyncLine = {
  lineStartTime?: number;
  lineEndTime?: number;
  syllables?: KineSyncSyllable[];
  backgroundSyllables?: KineSyncSyllable[];
  backgroundText?: string;
  translatedText?: string;
  oppositeAligned?: boolean;
};

type IncomingMessage = {
  type?: string;
  lines?: KineSyncLine[];
  positionMs?: number;
  previewPositionMs?: number | null;
  isPlaying?: boolean;
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
  lastLyricEndTime?: number;
  autoFollowEnabled?: boolean;
  resumeAutoFollowSignal?: number;
};
declare global {
  interface Window {
    KineSyncLyrics?: {
      receive: (message: IncomingMessage) => void;
    };
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

const root = document.getElementById("amll-root") || document.body;
const empty = document.getElementById("empty") as HTMLElement | null;
const emptyTitle = document.getElementById("emptyTitle") as HTMLElement | null;
const emptySub = document.getElementById("emptySub") as HTMLElement | null;

const player = new LyricPlayer();
const playerElement = player.getElement();
const sourceIndexByAmllLine: number[] = [];
const sourceKeyByIndex: string[] = [];

let sourceLines: KineSyncLine[] = [];
let selectedKeys: Record<string, boolean> = {};
let anchorPositionMs = 0;
let anchorClientMs = performance.now();
let isPlaying = false;
let previewPositionMs: number | null = null;
let durationMs = 0;
let lastFrameMs = performance.now();
let tapToSeekEnabled = true;
let showTranslatedText = true;
let landscapeMode = false;
let fontScale = 1;
let activeSourceIndex = -1;
let autoFollowEnabled = true;
let resumeAutoFollowSignal = 0;
let pressedLineClearTimer = 0;
let longPressTimer = 0;
let touchStartSourceIndex = -1;
let touchMoved = false;
let lastLyricEndTime = 0;
let frameRequestId: number | null = null;
let animateUntilMs = 0;
const IDLE_ANIMATION_GRACE_MS = 750;
root.appendChild(playerElement);
playerElement.classList.add("kinesync-amll-player");
player.setAlignAnchor(LayoutAlignAnchor.Top);
player.setAlignPosition(0.08);
player.setOverscanPx(420);
player.setWordFadeWidth(0.56);
player.setEnableScale(true);
player.setEnableBlur(true);
player.setEnableSpring(true);
player.setAlwaysPostpositionBackground(true);

function post(payload: unknown) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(payload));
}

function toFiniteMs(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : fallback;
}

function getSourceLineKey(line: KineSyncLine) {
  return `${toFiniteMs(line.lineStartTime)}-${toFiniteMs(line.lineEndTime)}`;
}

function syllablesToWords(
  syllables: KineSyncSyllable[] | undefined,
  fallbackStart: number,
  fallbackEnd: number,
) {
  const words = (Array.isArray(syllables) ? syllables : [])
    .map((syllable) => ({
      word: String(syllable?.text || ""),
      startTime: toFiniteMs(syllable?.startTime, fallbackStart),
      endTime: Math.max(
        toFiniteMs(syllable?.startTime, fallbackStart) + 1,
        toFiniteMs(syllable?.endTime, fallbackEnd),
      ),
    }))
    .filter((word) => word.word.length > 0);

  if (words.length) {
    return words;
  }

  return [
    {
      word: " ",
      startTime: fallbackStart,
      endTime: Math.max(fallbackStart + 1, fallbackEnd),
    },
  ];
}

function getBackgroundSyllables(line: KineSyncLine) {
  if (Array.isArray(line.backgroundSyllables) && line.backgroundSyllables.length) {
    return line.backgroundSyllables;
  }
  const text = String(line.backgroundText || "").trim();
  if (!text) {
    return [];
  }
  return [
    {
      text,
      startTime: line.lineStartTime,
      endTime: line.lineEndTime,
    },
  ];
}

function shouldRenderAsDuet(line: KineSyncLine) {
  const oppositeAligned = Boolean(line.oppositeAligned);
  return landscapeMode ? !oppositeAligned : oppositeAligned;
}

function convertLines(lines: KineSyncLine[]) {
  sourceIndexByAmllLine.length = 0;
  sourceKeyByIndex.length = 0;
  const converted: LyricLine[] = [];

  lines.forEach((line, sourceIndex) => {
    const startTime = toFiniteMs(line.lineStartTime);
    const endTime = Math.max(startTime + 1, toFiniteMs(line.lineEndTime, startTime + 1));
    sourceKeyByIndex[sourceIndex] = getSourceLineKey(line);
    converted.push({
      words: syllablesToWords(line.syllables, startTime, endTime),
      translatedLyric: showTranslatedText
        ? String(line.translatedText || "").trim()
        : "",
      romanLyric: "",
      startTime,
      endTime,
      isBG: false,
      isDuet: shouldRenderAsDuet(line),
    });
    sourceIndexByAmllLine.push(sourceIndex);

    const backgroundSyllables = getBackgroundSyllables(line);
    if (backgroundSyllables.length) {
      const bgStart = toFiniteMs(backgroundSyllables[0]?.startTime, endTime);
      const bgEnd = Math.max(
        bgStart + 1,
        toFiniteMs(
          backgroundSyllables[backgroundSyllables.length - 1]?.endTime,
          endTime,
        ),
      );
      converted.push({
        words: syllablesToWords(backgroundSyllables, bgStart, bgEnd),
        translatedLyric: "",
        romanLyric: "",
        startTime: bgStart,
        endTime: bgEnd,
        isBG: true,
        isDuet: shouldRenderAsDuet(line),
      });
      sourceIndexByAmllLine.push(sourceIndex);
    }
  });

  return converted;
}

function getProjectedPosition() {
  if (previewPositionMs !== null && Number.isFinite(previewPositionMs)) {
    return Math.max(0, previewPositionMs);
  }
  const elapsed = isPlaying ? performance.now() - anchorClientMs : 0;
  const next = Math.max(0, anchorPositionMs + elapsed);
  return durationMs > 0 ? Math.min(durationMs, next) : next;
}

function updatePlayerClass() {
  playerElement.classList.toggle("landscape", landscapeMode);
  playerElement.style.setProperty("--ks-font-scale", String(Math.max(0.82, Math.min(1.35, fontScale))));
}

function updateSelectionClasses() {
  const groups = Array.from(playerElement.querySelectorAll("[class*='lyricLineWrapper']"));
  groups.forEach((group, index) => {
    const sourceIndex = sourceIndexByAmllLine[index] ?? -1;
    const key = sourceKeyByIndex[sourceIndex] || "";
    group.classList.toggle("kinesync-selected-line", Boolean(key && selectedKeys[key]));
  });
}

function showEmpty(title: string, sub: string) {
  if (!empty) return;
  empty.hidden = sourceLines.length > 0;
  if (emptyTitle) emptyTitle.textContent = title;
  if (emptySub) emptySub.textContent = sub;
}

function renderCredits(songwriters: string[] = [], endTime = 0) {
  const bottomLine = player.getBottomLineElement();
  bottomLine.replaceChildren();
  lastLyricEndTime = toFiniteMs(endTime);
  if (!songwriters.length) {
    bottomLine.classList.remove("kinesync-credits-footer");
    return;
  }
  bottomLine.classList.add("kinesync-credits-footer");
  const label = document.createElement("span");
  label.className = "kinesync-credits-strong";
  label.textContent = "Written By: ";
  const names = document.createElement("span");
  names.textContent = songwriters.join(", ");
  bottomLine.append(label, names);
}

async function relayout(force = false) {
  await player.calcLayout(true, force);
  updateSelectionClasses();
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
}

function setLyrics(message: IncomingMessage) {
  sourceLines = Array.isArray(message.lines) ? message.lines : [];
  activeSourceIndex = -1;
  const converted = convertLines(sourceLines);
  player.setLyricLines(converted, getProjectedPosition());
  renderCredits(message.songwriters || [], toFiniteMs(message.lastLyricEndTime));
  showEmpty(message.emptyTitle || "No synced lyrics yet", message.emptySub || "");
  void relayout(true);
}

function applyOptions(message: IncomingMessage) {
  const translationsChanged = showTranslatedText !== Boolean(message.showTranslatedText);
  const nextLandscapeMode = Boolean(message.landscapeMode);
  const landscapeChanged = landscapeMode !== nextLandscapeMode;
  showTranslatedText = Boolean(message.showTranslatedText);
  tapToSeekEnabled = Boolean(message.tapToSeekEnabled);
  landscapeMode = nextLandscapeMode;
  fontScale = toFiniteMs(message.fontScale, 1);
  selectedKeys = message.selectedKeys || {};
  if (typeof message.autoFollowEnabled === "boolean") {
    autoFollowEnabled = message.autoFollowEnabled;
  }
  if (
    typeof message.resumeAutoFollowSignal === "number" &&
    message.resumeAutoFollowSignal !== resumeAutoFollowSignal
  ) {
    resumeAutoFollowSignal = message.resumeAutoFollowSignal;
    autoFollowEnabled = true;
    player.resetScroll();
    void relayout(true);
  }
  player.setIsSeeking(!autoFollowEnabled);
  updatePlayerClass();
  if ((translationsChanged || landscapeChanged) && sourceLines.length) {
    player.setLyricLines(convertLines(sourceLines), getProjectedPosition());
    void relayout(true);
  } else {
    updateSelectionClasses();
  }
}

function sync(message: IncomingMessage) {
  const nextPosition = toFiniteMs(message.positionMs);
  const wasFar = Math.abs(getProjectedPosition() - nextPosition) > 900;
  anchorPositionMs = nextPosition;
  anchorClientMs = performance.now();
  isPlaying = Boolean(message.isPlaying);
  durationMs = toFiniteMs(message.durationMs);
  previewPositionMs = message.previewPositionMs === null || message.previewPositionMs === undefined
    ? null
    : toFiniteMs(message.previewPositionMs);
  player.setCurrentTime(getProjectedPosition(), wasFar || Boolean(message.force));
  if (isPlaying && previewPositionMs === null) {
    player.resume();
  } else {
    player.pause();
  }
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
  if ((wasFar || message.force) && autoFollowEnabled) {
    player.resetScroll();
    void relayout(true);
  }
}

function getLineWrappers() {
  return Array.from(playerElement.querySelectorAll("[class*='lyricLineWrapper']"));
}

function getSourceIndexFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return -1;
  }
  const wrapper = target.closest("[class*='lyricLineWrapper']");
  if (!wrapper) {
    return -1;
  }
  const amllIndex = getLineWrappers().indexOf(wrapper);
  return sourceIndexByAmllLine[amllIndex] ?? -1;
}

function getSourceIndexFromLineEvent(event: Event) {
  const lyricEvent = event as LyricLineMouseEvent;
  const byLineIndex = sourceIndexByAmllLine[lyricEvent.lineIndex] ?? -1;
  if (byLineIndex >= 0 && byLineIndex < sourceLines.length) {
    return byLineIndex;
  }
  return getSourceIndexFromTarget(event.target);
}

function setPressedSourceIndex(sourceIndex: number) {
  window.clearTimeout(pressedLineClearTimer);
  getLineWrappers().forEach((group, index) => {
    group.classList.toggle(
      "kinesync-pressed-line",
      sourceIndexByAmllLine[index] === sourceIndex,
    );
  });
  pressedLineClearTimer = window.setTimeout(() => {
    getLineWrappers().forEach((group) => {
      group.classList.remove("kinesync-pressed-line");
    });
  }, 420);
}

function setAutoFollow(nextEnabled: boolean) {
  if (autoFollowEnabled === nextEnabled) {
    return;
  }
  autoFollowEnabled = nextEnabled;
  player.setIsSeeking(!autoFollowEnabled);
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
  post({ type: "autoFollowChange", enabled: autoFollowEnabled });
}

function handleLineMouseEvent(event: Event) {
  const sourceIndex = getSourceIndexFromLineEvent(event);
  if (sourceIndex < 0 || sourceIndex >= sourceLines.length) {
    return;
  }
  event.preventDefault();
  setPressedSourceIndex(sourceIndex);
  if (event.type === "line-contextmenu") {
    post({ type: "lineLongPress", index: sourceIndex });
    return;
  }
  if (tapToSeekEnabled) {
    setAutoFollow(true);
    player.resetScroll();
    void relayout(true);
    post({ type: "linePress", index: sourceIndex });
  }
}

player.addEventListener("line-click", handleLineMouseEvent);
player.addEventListener("line-contextmenu", handleLineMouseEvent);

playerElement.addEventListener(
  "touchstart",
  (event) => {
    touchMoved = false;
    touchStartSourceIndex = getSourceIndexFromTarget(event.target);
    window.clearTimeout(longPressTimer);
    if (touchStartSourceIndex >= 0) {
      longPressTimer = window.setTimeout(() => {
        if (!touchMoved && touchStartSourceIndex >= 0) {
          setPressedSourceIndex(touchStartSourceIndex);
          post({ type: "lineLongPress", index: touchStartSourceIndex });
        }
      }, 540);
    }
  },
  { passive: true },
);

playerElement.addEventListener(
  "touchmove",
  () => {
    touchMoved = true;
    window.clearTimeout(longPressTimer);
    setAutoFollow(false);
  },
  { passive: true },
);

playerElement.addEventListener(
  "touchend",
  () => {
    window.clearTimeout(longPressTimer);
    touchStartSourceIndex = -1;
  },
  { passive: true },
);

playerElement.addEventListener(
  "wheel",
  () => {
    setAutoFollow(false);
  },
  { passive: true },
);

player.getBottomLineElement().addEventListener("click", () => {
  if (lastLyricEndTime > 0) {
    setAutoFollow(true);
    player.resetScroll();
    void relayout(true);
    post({ type: "creditsPress", positionMs: lastLyricEndTime });
  }
});

function playbackNeedsFrames() {
  return (
    isPlaying &&
    previewPositionMs === null &&
    sourceLines.length > 0 &&
    (durationMs <= 0 || getProjectedPosition() < durationMs)
  );
}

function scheduleFrame(graceMs = 0) {
  const now = performance.now();
  animateUntilMs = Math.max(animateUntilMs, now + Math.max(0, graceMs));
  if (document.visibilityState === "hidden" || frameRequestId !== null) {
    return;
  }
  lastFrameMs = now;
  frameRequestId = requestAnimationFrame(frame);
}

function frame() {
  frameRequestId = null;
  const now = performance.now();
  const delta = Math.max(0, Math.min(80, now - lastFrameMs));
  lastFrameMs = now;
  const position = getProjectedPosition();
  player.setCurrentTime(position);
  player.update(delta);

  const activeAmllIndex = sourceIndexByAmllLine.findIndex((sourceIndex) => {
    const line = sourceLines[sourceIndex];
    if (!line) return false;
    const start = toFiniteMs(line.lineStartTime);
    const end = Math.max(start + 1, toFiniteMs(line.lineEndTime, start + 1));
    return position >= start && position < end;
  });
  const nextActiveSourceIndex = sourceIndexByAmllLine[activeAmllIndex] ?? -1;
  if (nextActiveSourceIndex !== activeSourceIndex) {
    activeSourceIndex = nextActiveSourceIndex;
    post({ type: "activeLineChange", index: activeSourceIndex });
  }

  if (playbackNeedsFrames() || now < animateUntilMs) {
    frameRequestId = requestAnimationFrame(frame);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (frameRequestId !== null) {
      cancelAnimationFrame(frameRequestId);
      frameRequestId = null;
    }
    return;
  }
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
});

window.KineSyncLyrics = {
  receive(message: IncomingMessage) {
    if (!message || typeof message !== "object") return;
    if (message.type === "setLyrics") {
      setLyrics(message);
      return;
    }
    if (message.type === "options") {
      applyOptions(message);
      return;
    }
    if (message.type === "sync") {
      sync(message);
    }
  },
};

updatePlayerClass();
scheduleFrame(IDLE_ANIMATION_GRACE_MS);
post({ type: "ready" });