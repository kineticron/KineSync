/*
 * KineSync standalone WebView adapter for Spicy Lyrics.
 * Renderer DOM/CSS contract and animation curves are adapted from
 * Spikerko/spicy-lyrics v6.3.15, commit 2a14863f8c29782f9ab3becff2b1360dfb74a4fb.
 * Upstream license: AGPL-3.0.
 */
import "./spicy-webview.css";

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

type RenderedLine = {
  sourceIndex: number;
  line: KineSyncLine;
  element: HTMLDivElement;
  words: { syllable: KineSyncSyllable; element: HTMLElement }[];
  backgroundElement?: HTMLDivElement;
  backgroundWords?: { syllable: KineSyncSyllable; element: HTMLElement }[];
};

const page = document.getElementById("SpicyLyricsPage") as HTMLElement | null;
const scrollRoot = document.getElementById("spicyScrollRoot") as HTMLElement | null;
const empty = document.getElementById("empty") as HTMLElement | null;
const emptyTitle = document.getElementById("emptyTitle") as HTMLElement | null;
const emptySub = document.getElementById("emptySub") as HTMLElement | null;
const creditsRoot = document.getElementById("spicyCredits") as HTMLElement | null;
const staticLyricsRoot = document.getElementById("staticLyricsRoot") as HTMLElement | null;

let sourceLines: KineSyncLine[] = [];
let renderedLines: RenderedLine[] = [];
let selectedKeys: Record<string, boolean> = {};
let anchorPositionMs = 0;
let anchorClientMs = performance.now();
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
let staticSongwriters: string[] = [];
let staticAttribution: LyricsAttribution | undefined;
let frameRequestId: number | null = null;
let animateUntilMs = 0;
let longPressTimer = 0;
let pressedTimer = 0;
let touchStartIndex = -1;
let touchMoved = false;
let longPressTriggered = false;
let scrollVelocity = 0;
let scrollTarget = 0;
let userScrolling = false;
const IDLE_ANIMATION_GRACE_MS = 750;

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
  const elapsed = isPlaying ? performance.now() - anchorClientMs : 0;
  const next = Math.max(0, anchorPositionMs + elapsed);
  return durationMs > 0 ? Math.min(durationMs, next) : next;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function interpolate(points: [number, number][], progress: number) {
  const p = clamp01(progress);
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (p <= x1) {
      const t = (p - x0) / Math.max(0.0001, x1 - x0);
      return y0 + (y1 - y0) * clamp01(t);
    }
  }
  return points[points.length - 1][1];
}

function getBackgroundSyllables(line: KineSyncLine) {
  if (line.backgroundSyllables?.length) return line.backgroundSyllables;
  const text = String(line.backgroundText || "").trim();
  if (!text) return [];
  return [{ text, startTime: line.lineStartTime, endTime: line.lineEndTime }];
}

function renderWord(parent: HTMLElement, syllable: KineSyncSyllable, last: boolean) {
  const word = document.createElement("span");
  word.className = "word";
  if (syllable.isPartOfWord) word.classList.add("PartOfWord");
  if (last) word.classList.add("LastWordInLine");
  word.textContent = String(syllable.text || "");
  parent.appendChild(word);
  return word;
}

function appendTranslation(parent: HTMLElement, text: string | undefined) {
  const value = String(text || "").trim();
  if (!showTranslatedText || !value) return;
  const translation = document.createElement("div");
  translation.className = "ks-translation";
  translation.textContent = value;
  parent.appendChild(translation);
}

function createLineElement(line: KineSyncLine, sourceIndex: number) {
  const lineElement = document.createElement("div");
  lineElement.className = "line NotSung";
  lineElement.dataset.sourceIndex = String(sourceIndex);
  const opposite = landscapeMode ? !line.oppositeAligned : Boolean(line.oppositeAligned);
  lineElement.classList.toggle("OppositeAligned", opposite);

  const syllables = line.syllables || [];
  const words = syllables.map((syllable, index) => ({
    syllable,
    element: renderWord(lineElement, syllable, index === syllables.length - 1),
  }));
  appendTranslation(lineElement, line.translatedText);

  const rendered: RenderedLine = { sourceIndex, line, element: lineElement, words };
  const background = getBackgroundSyllables(line);
  if (background.length) {
    const bg = document.createElement("div");
    bg.className = "line bg-line NotSung";
    bg.dataset.sourceIndex = String(sourceIndex);
    bg.classList.toggle("OppositeAligned", opposite);
    const bgWords = background.map((syllable, index) => ({
      syllable,
      element: renderWord(bg, syllable, index === background.length - 1),
    }));
    appendTranslation(bg, line.backgroundTranslatedText);
    rendered.backgroundElement = bg;
    rendered.backgroundWords = bgWords;
  }
  return rendered;
}

function renderSyncedLyrics() {
  if (!scrollRoot) return;
  scrollRoot.replaceChildren();
  renderedLines = sourceLines.map((line, index) => createLineElement(line, index));
  for (const rendered of renderedLines) {
    scrollRoot.appendChild(rendered.element);
    if (rendered.backgroundElement) scrollRoot.appendChild(rendered.backgroundElement);
  }
  if (creditsRoot) {
    scrollRoot.appendChild(creditsRoot);
  }
  updateSelection();
}

function getStaticLineText(line: KineSyncLine) {
  return (line.syllables || []).map((s) => String(s.text || "")).join("").trim();
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
  const appendProfile = (
    label: string,
    profile: { username?: string; avatar?: string },
  ) => {
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
    appendProfile(
      attribution.maker?.username ? "Uploaded By: " : "Made By: ",
      attribution.uploader,
    );
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
  staticLyricsRoot.replaceChildren();
  for (const line of sourceLines) {
    const text = getStaticLineText(line);
    if (!text) continue;
    const row = document.createElement("div");
    row.className = "static-lyrics-line";
    row.textContent = text;
    if (showTranslatedText && line.translatedText) {
      const translated = document.createElement("div");
      translated.className = "static-lyrics-translation";
      translated.textContent = line.translatedText;
      row.appendChild(translated);
    }
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
    staticLyricsRoot.appendChild(row);
  }
  if (staticSongwriters.length || staticAttribution) {
    const credits = document.createElement("div");
    credits.className = "kinesync-credits-footer";
    appendCreditsContent(credits, staticSongwriters, staticAttribution);
    staticLyricsRoot.appendChild(credits);
  }
}

function updateSelection() {
  for (const rendered of renderedLines) {
    const selected = Boolean(selectedKeys[sourceKey(rendered.line)]);
    rendered.element.classList.toggle("ks-selected", selected);
    rendered.backgroundElement?.classList.toggle("ks-selected", selected);
  }
}

function showEmpty(title: string, sub: string) {
  if (!empty) return;
  empty.hidden = sourceLines.length > 0;
  if (emptyTitle) emptyTitle.textContent = title;
  if (emptySub) emptySub.textContent = sub;
}

function applyPageOptions() {
  page?.classList.toggle("landscape", landscapeMode);
  page?.style.setProperty("--ks-font-scale", String(Math.max(0.82, Math.min(1.35, fontScale))));
  staticLyricsRoot?.classList.toggle("landscape", landscapeMode);
  staticLyricsRoot?.style.setProperty("--ks-font-scale", String(Math.max(0.82, Math.min(1.35, fontScale))));
}

function lineProgress(position: number, start: number, end: number) {
  return clamp01((position - start) / Math.max(1, end - start));
}

function updateWordVisual(entry: { syllable: KineSyncSyllable; element: HTMLElement }, position: number) {
  const start = finiteMs(entry.syllable.startTime);
  const end = Math.max(start + 1, finiteMs(entry.syllable.endTime, start + 1));
  const p = lineProgress(position, start, end);
  const active = position >= start && position < end;
  const sung = position >= end;
  const gradient = sung ? 100 : active ? -20 + p * 120 : -20;
  entry.element.style.setProperty("--gradient-position", `${gradient}%`);

  if (active) {
    // Spicy Lyrics' syllable renderer uses a 0.95 -> 1.0505 -> 1 scale arc,
    // upward motion, and a glow envelope while the word is active.
    const scale = interpolate([[0, 0.95], [0.7, 1.0505], [1, 1]], p);
    const y = interpolate([[0, 0.01], [0.9, -1 / 60], [1, 0]], p);
    const glow = interpolate([[0, 0], [0.15, 1], [0.6, 1], [1, 0]], p);
    entry.element.style.transform = `translateY(${y}em) scale(${scale})`;
    entry.element.style.setProperty("--text-shadow-opacity", `${Math.round(glow * 55)}%`);
  } else {
    entry.element.style.transform = sung ? "translateY(0) scale(1)" : "translateY(0.01em) scale(0.95)";
    entry.element.style.setProperty("--text-shadow-opacity", "0%");
  }
}

function updateLineVisual(rendered: RenderedLine, position: number) {
  const start = finiteMs(rendered.line.lineStartTime);
  const end = Math.max(start + 1, finiteMs(rendered.line.lineEndTime, start + 1));
  const active = position >= start && position < end;
  const sung = position >= end;
  rendered.element.classList.toggle("Active", active);
  rendered.element.classList.toggle("Sung", sung);
  rendered.element.classList.toggle("NotSung", !active && !sung);
  for (const word of rendered.words) updateWordVisual(word, position);

  if (rendered.backgroundElement && rendered.backgroundWords?.length) {
    const bgStart = finiteMs(rendered.backgroundWords[0].syllable.startTime, start);
    const bgEnd = Math.max(
      bgStart + 1,
      finiteMs(rendered.backgroundWords[rendered.backgroundWords.length - 1].syllable.endTime, end),
    );
    const bgActive = position >= bgStart && position < bgEnd;
    const bgSung = position >= bgEnd;
    rendered.backgroundElement.classList.toggle("Active", bgActive);
    rendered.backgroundElement.classList.toggle("Sung", bgSung);
    rendered.backgroundElement.classList.toggle("NotSung", !bgActive && !bgSung);
    for (const word of rendered.backgroundWords) updateWordVisual(word, position);
  }
}

function updateAutoFollow(deltaMs: number) {
  if (!scrollRoot || !autoFollowEnabled || activeSourceIndex < 0) return;
  const target = renderedLines[activeSourceIndex]?.element;
  if (!target) return;
  const desired = Math.max(0, target.offsetTop - scrollRoot.clientHeight * 0.08);
  scrollTarget = desired;
  if (previewPositionMs !== null) {
    scrollRoot.scrollTop = desired;
    scrollVelocity = 0;
    return;
  }
  const dt = Math.min(0.05, Math.max(0.001, deltaMs / 1000));
  const displacement = scrollRoot.scrollTop - scrollTarget;
  // Damped spring: mirrors Spicy's spring-driven convergence without polling Spotify.
  const acceleration = -170 * displacement - 26 * scrollVelocity;
  scrollVelocity += acceleration * dt;
  const next = scrollRoot.scrollTop + scrollVelocity * dt;
  scrollRoot.scrollTop = Math.abs(next - desired) < 0.4 && Math.abs(scrollVelocity) < 2 ? desired : next;
}

function update(position: number, deltaMs: number) {
  if (staticLyricsMode) return;
  let nextActive = -1;
  for (const rendered of renderedLines) {
    updateLineVisual(rendered, position);
    const start = finiteMs(rendered.line.lineStartTime);
    const end = Math.max(start + 1, finiteMs(rendered.line.lineEndTime, start + 1));
    if (position >= start && position < end) nextActive = rendered.sourceIndex;
  }
  if (nextActive !== activeSourceIndex) {
    activeSourceIndex = nextActive;
    post({ type: "activeLineChange", index: activeSourceIndex });
  }
  updateAutoFollow(deltaMs);
}

function setLyrics(message: IncomingMessage) {
  sourceLines = Array.isArray(message.lines) ? message.lines : [];
  staticLyricsMode = message.timingMode === "static";
  staticSongwriters = Array.isArray(message.songwriters) ? message.songwriters : [];
  staticAttribution = message.attribution;
  activeSourceIndex = -1;
  if (scrollRoot) scrollRoot.hidden = staticLyricsMode;
  if (staticLyricsRoot) staticLyricsRoot.hidden = !staticLyricsMode;
  if (staticLyricsMode) {
    renderStaticLyrics();
    staticLyricsRoot?.scrollTo({ top: 0, behavior: "auto" });
    post({ type: "activeLineChange", index: -1 });
  } else {
    renderSyncedLyrics();
    renderCredits(message.songwriters || [], message.attribution, finiteMs(message.lastLyricEndTime));
    if (scrollRoot) scrollRoot.scrollTop = 0;
  }
  showEmpty(message.emptyTitle || "No synced lyrics yet", message.emptySub || "");
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
}

function applyOptions(message: IncomingMessage) {
  const translationsChanged = showTranslatedText !== Boolean(message.showTranslatedText);
  const nextLandscape = Boolean(message.landscapeMode);
  const landscapeChanged = landscapeMode !== nextLandscape;
  showTranslatedText = Boolean(message.showTranslatedText);
  tapToSeekEnabled = Boolean(message.tapToSeekEnabled);
  landscapeMode = nextLandscape;
  fontScale = finiteMs(message.fontScale, 1);
  selectedKeys = message.selectedKeys || {};
  if (typeof message.autoFollowEnabled === "boolean") autoFollowEnabled = message.autoFollowEnabled;
  if (typeof message.resumeAutoFollowSignal === "number" && message.resumeAutoFollowSignal !== resumeAutoFollowSignal) {
    resumeAutoFollowSignal = message.resumeAutoFollowSignal;
    autoFollowEnabled = true;
    scrollVelocity = 0;
  }
  applyPageOptions();
  if ((translationsChanged || landscapeChanged) && sourceLines.length) {
    if (staticLyricsMode) renderStaticLyrics();
    else renderSyncedLyrics();
  }
  updateSelection();
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
}

function sync(message: IncomingMessage) {
  const next = finiteMs(message.positionMs);
  const force = Boolean(message.force) || Math.abs(projectedPosition() - next) > 900;
  anchorPositionMs = next;
  anchorClientMs = performance.now();
  isPlaying = Boolean(message.isPlaying);
  durationMs = finiteMs(message.durationMs);
  previewPositionMs = message.previewPositionMs == null ? null : finiteMs(message.previewPositionMs);
  if (force) {
    scrollVelocity = 0;
    update(projectedPosition(), 16);
  }
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
}

function setAutoFollow(enabled: boolean) {
  if (autoFollowEnabled === enabled) return;
  autoFollowEnabled = enabled;
  scrollVelocity = 0;
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
  for (const rendered of renderedLines) {
    const pressed = rendered.sourceIndex === index;
    rendered.element.classList.toggle("ks-pressed", pressed);
    rendered.backgroundElement?.classList.toggle("ks-pressed", pressed);
  }
  pressedTimer = window.setTimeout(() => {
    document.querySelectorAll(".ks-pressed").forEach((node) => node.classList.remove("ks-pressed"));
  }, 420);
}

scrollRoot?.addEventListener("click", (event) => {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  const index = sourceIndexFromTarget(event.target);
  if (index < 0 || index >= sourceLines.length) return;
  setPressed(index);
  if (tapToSeekEnabled) {
    setAutoFollow(true);
    post({ type: "linePress", index });
  }
});

scrollRoot?.addEventListener("contextmenu", (event) => {
  const index = sourceIndexFromTarget(event.target);
  if (index < 0 || index >= sourceLines.length) return;
  event.preventDefault();
  setPressed(index);
  post({ type: "lineLongPress", index });
});

scrollRoot?.addEventListener("touchstart", (event) => {
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

scrollRoot?.addEventListener("touchmove", () => {
  touchMoved = true;
  userScrolling = true;
  window.clearTimeout(longPressTimer);
  setAutoFollow(false);
}, { passive: true });

scrollRoot?.addEventListener("touchend", () => {
  window.clearTimeout(longPressTimer);
  touchStartIndex = -1;
  userScrolling = false;
}, { passive: true });

scrollRoot?.addEventListener("wheel", () => {
  userScrolling = true;
  setAutoFollow(false);
  window.setTimeout(() => { userScrolling = false; }, 150);
}, { passive: true });

creditsRoot?.addEventListener("click", () => {
  if (lastLyricEndTime <= 0) return;
  setAutoFollow(true);
  post({ type: "creditsPress", positionMs: lastLyricEndTime });
});

function playbackNeedsFrames() {
  return !staticLyricsMode && isPlaying && previewPositionMs === null && sourceLines.length > 0 && (durationMs <= 0 || projectedPosition() < durationMs);
}

function scheduleFrame(graceMs = 0) {
  const now = performance.now();
  animateUntilMs = Math.max(animateUntilMs, now + Math.max(0, graceMs));
  if (document.visibilityState === "hidden" || frameRequestId !== null) return;
  frameRequestId = requestAnimationFrame(frame);
}

let lastFrameMs = performance.now();
function frame(now: number) {
  frameRequestId = null;
  const delta = Math.max(0, Math.min(80, now - lastFrameMs));
  lastFrameMs = now;
  update(projectedPosition(), delta || 16);
  if (playbackNeedsFrames() || now < animateUntilMs || (!userScrolling && Math.abs(scrollVelocity) > 0.5)) {
    frameRequestId = requestAnimationFrame(frame);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (frameRequestId !== null) cancelAnimationFrame(frameRequestId);
    frameRequestId = null;
    return;
  }
  lastFrameMs = performance.now();
  scheduleFrame(IDLE_ANIMATION_GRACE_MS);
});

bridgeWindow.KineSyncLyrics = {
  receive(message: IncomingMessage) {
    if (!message || typeof message !== "object") return;
    if (message.type === "setLyrics") setLyrics(message);
    else if (message.type === "options") applyOptions(message);
    else if (message.type === "sync") sync(message);
  },
};

applyPageOptions();
post({ type: "ready" });
