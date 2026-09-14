/*
 * Standalone port of the normal-mode Spicy Lyrics v6.3.15 lyric runtime.
 * Source: Spikerko/spicy-lyrics @ 2a14863f8c29782f9ab3becff2b1360dfb74a4fb
 *
 * This intentionally keeps the upstream data model (renderer lines containing
 * lead/background/dot entries) and animator lifecycle. KineSync-specific bridge
 * behavior lives in spicy-webview-entry.ts, outside this module.
 */
import Spline from "cubic-spline";
import { easeSinOut } from "d3-ease";

export type SpicyElementStatus = "NotSung" | "Active" | "Sung";

export type SpicyAnimatorStore = {
  Scale: Spring;
  YOffset: Spring;
  Glow: Spring;
  Opacity?: Spring;
};

export type SpicyLetter = {
  HTMLElement: HTMLElement;
  StartTime: number;
  EndTime: number;
  TotalTime: number;
  Status?: SpicyElementStatus;
  AnimatorStore?: SpicyAnimatorStore;
  Emphasis?: boolean;
  BGLetter?: boolean;
};

export type SpicyWord = {
  HTMLElement: HTMLElement;
  StartTime: number;
  EndTime: number;
  TotalTime: number;
  Status?: SpicyElementStatus;
  LetterGroup?: boolean;
  Letters?: SpicyLetter[];
  BGWord?: boolean;
  Dot?: boolean;
  AnimatorStore?: SpicyAnimatorStore;
};

export type SpicyRuntimeLine = {
  HTMLElement: HTMLElement;
  StartTime: number;
  EndTime: number;
  TotalTime: number;
  Status?: SpicyElementStatus;
  Syllables?: { Lead: SpicyWord[] };
  AnimatorStore?: { Glow: Spring };
  DotLine?: boolean;
  BGLine?: boolean;
  sourceIndex?: number;
};

export type SpicyLyricsType = "Syllable" | "Line";

const SLEEP_OFFSET_SQ_LIMIT = (1 / 3840) ** 2;
const SLEEP_VELOCITY_SQ_LIMIT = 1e-2 ** 2;
const EPS = 1e-5;

// Literal TypeScript port used by Spicy Lyrics (itself a port of Fraktality/spr).
export class Spring {
  private d: number;
  private f: number;
  private g: number;
  private p: number;
  private v: number;

  constructor(startPosition: number, frequency: number, dampingRatio: number, goal?: number) {
    this.d = dampingRatio;
    this.f = frequency;
    this.g = goal ?? startPosition;
    this.p = startPosition;
    this.v = 0;
  }

  Step(dt: number): number {
    const d = this.d;
    const f = this.f * (2 * Math.PI);
    const g = this.g;
    let p = this.p;
    let v = this.v;

    if (d === 1) {
      const q = Math.exp(-f * dt);
      const w = dt * q;
      const c0 = q + w * f;
      const c2 = q - w * f;
      const c3 = w * f * f;
      const o = p - g;
      p = o * c0 + v * w + g;
      v = v * c2 - o * c3;
    } else if (d < 1) {
      const q = Math.exp(-d * f * dt);
      const c = Math.sqrt(1 - d * d);
      const i = Math.cos(dt * f * c);
      const j = Math.sin(dt * f * c);
      let z: number;
      if (c > EPS) {
        z = j / c;
      } else {
        const a = dt * f;
        z = a + ((a * a) * (c * c) * (c * c) / 20 - c * c) * (a * a * a) / 6;
      }
      let y: number;
      if (f * c > EPS) {
        y = j / (f * c);
      } else {
        const b = f * c;
        y = dt + ((dt * dt) * (b * b) * (b * b) / 20 - b * b) * (dt * dt * dt) / 6;
      }
      const o = p - g;
      p = (o * (i + z * d) + v * y) * q + g;
      v = (v * (i - z * d) - o * (z * f)) * q;
    } else {
      const c = Math.sqrt(d * d - 1);
      const r1 = -f * (d + c);
      const r2 = -f * (d - c);
      const ec1 = Math.exp(r1 * dt);
      const ec2 = Math.exp(r2 * dt);
      const o = p - g;
      const co2 = (v - o * r1) / (2 * f * c);
      const co1 = ec1 * (o - co2);
      p = co1 + co2 * ec2 + g;
      v = co1 * r1 + co2 * ec2 * r2;
    }

    this.p = p;
    this.v = v;
    return p;
  }

  CanSleep(): boolean {
    if (this.v * this.v > SLEEP_VELOCITY_SQ_LIMIT) return false;
    const offset = this.p - this.g;
    return offset * offset <= SLEEP_OFFSET_SQ_LIMIT;
  }

  GetGoal(): number {
    return this.g;
  }

  SetGoal(goal: number, replacePosition?: boolean): void {
    this.g = goal;
    if (replacePosition) {
      this.p = goal;
      this.v = 0;
    }
  }

  SetDampingRatio(dampingRatio: number): void {
    this.d = dampingRatio;
  }

  SetFrequency(frequency: number): void {
    this.f = frequency;
  }
}

type AnimationPoint = { Time: number; Value: number };
const getSpline = (range: AnimationPoint[]) =>
  new Spline(range.map((value) => value.Time), range.map((value) => value.Value));

const SCALE_SPLINE = getSpline([
  { Time: 0, Value: 0.95 },
  { Time: 0.7, Value: 1.0505 },
  { Time: 1, Value: 1 },
]);
const LETTER_SCALE_SPLINE = getSpline([
  { Time: 0, Value: 0.95 },
  { Time: 0.7, Value: 1.175 },
  { Time: 1, Value: 1 },
]);
const Y_OFFSET_SPLINE = getSpline([
  { Time: 0, Value: 1 / 100 },
  { Time: 0.9, Value: -(1 / 60) },
  { Time: 1, Value: 0 },
]);
const LETTER_Y_OFFSET_SPLINE = getSpline([
  { Time: 0, Value: 1 / 100 },
  { Time: 0.9, Value: -(1 / 56) },
  { Time: 1, Value: 0 },
]);
const GLOW_SPLINE = getSpline([
  { Time: 0, Value: 0 },
  { Time: 0.15, Value: 1 },
  { Time: 0.6, Value: 1 },
  { Time: 1, Value: 0 },
]);
const DOT_SCALE_SPLINE = getSpline([
  { Time: 0, Value: 0.75 },
  { Time: 0.7, Value: 1.05 },
  { Time: 1, Value: 1 },
]);
const DOT_Y_OFFSET_SPLINE = getSpline([
  { Time: 0, Value: 0 },
  { Time: 0.9, Value: -0.12 },
  { Time: 1, Value: 0 },
]);
const DOT_GLOW_SPLINE = getSpline([
  { Time: 0, Value: 0 },
  { Time: 0.6, Value: 1 },
  { Time: 1, Value: 1 },
]);
const DOT_OPACITY_SPLINE = getSpline([
  { Time: 0, Value: 0.35 },
  { Time: 0.6, Value: 1 },
  { Time: 1, Value: 1 },
]);

const BLUR_MULTIPLIER = 1.25;
const PRE_HIDDEN_DOT_LINE_MS = 500;
const LETTER_GLOW_MULTIPLIER_OPACITY = 185;
const SUNG_LETTER_GLOW = 0.2;
const Y_OFFSET_DAMPING = 0.4;
const Y_OFFSET_FREQUENCY = 1.45;
const SCALE_DAMPING = 0.64;
const SCALE_FREQUENCY = 0.88;
const GLOW_DAMPING = 0.56;
const GLOW_FREQUENCY = 1.18;
const LINE_GLOW_DAMPING = 0.5;
const LINE_GLOW_FREQUENCY = 1;

const LINE_GLOW_SPLINE = getSpline([
  { Time: 0, Value: 0 },
  { Time: 0.5, Value: 1 },
  { Time: 1, Value: 0 },
]);

const createWordSprings = (): SpicyAnimatorStore => ({
  Scale: new Spring(SCALE_SPLINE.at(0), SCALE_FREQUENCY, SCALE_DAMPING),
  YOffset: new Spring(Y_OFFSET_SPLINE.at(0), Y_OFFSET_FREQUENCY, Y_OFFSET_DAMPING),
  Glow: new Spring(GLOW_SPLINE.at(0), GLOW_FREQUENCY, GLOW_DAMPING),
});

const createLetterSprings = (): SpicyAnimatorStore => ({
  Scale: new Spring(LETTER_SCALE_SPLINE.at(0), SCALE_FREQUENCY, SCALE_DAMPING),
  YOffset: new Spring(LETTER_Y_OFFSET_SPLINE.at(0), Y_OFFSET_FREQUENCY, Y_OFFSET_DAMPING),
  Glow: new Spring(GLOW_SPLINE.at(0), GLOW_FREQUENCY, GLOW_DAMPING),
});

const createDotSprings = (): SpicyAnimatorStore => ({
  Scale: new Spring(DOT_SCALE_SPLINE.at(0), 0.7, 0.6),
  YOffset: new Spring(DOT_Y_OFFSET_SPLINE.at(0), 1.25, 0.4),
  Glow: new Spring(DOT_GLOW_SPLINE.at(0), 1, 0.5),
  Opacity: new Spring(DOT_OPACITY_SPLINE.at(0), 1, 0.5),
});

const createLineSprings = (): { Glow: Spring } => ({
  Glow: new Spring(LINE_GLOW_SPLINE.at(0), LINE_GLOW_FREQUENCY, LINE_GLOW_DAMPING),
});

const styleCache = new WeakMap<HTMLElement, Map<string, string>>();
const styleQueue = new Map<HTMLElement, Map<string, string>>();
const gpuPromotedWithFilter = new WeakSet<HTMLElement>();

function queueStyle(el: HTMLElement, prop: string, value: string): void {
  let props = styleQueue.get(el);
  if (!props) {
    props = new Map();
    styleQueue.set(el, props);
  }
  props.set(prop, value);
}

function setStyleIfChanged(el: HTMLElement, prop: string, value: string, epsilon = 0): void {
  let map = styleCache.get(el);
  if (!map) {
    map = new Map();
    styleCache.set(el, map);
  }
  const prev = map.get(prop);
  if (prev !== undefined) {
    const a = parseFloat(prev);
    const b = parseFloat(value);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      if (Math.abs(a - b) <= epsilon) return;
    } else if (prev === value) {
      return;
    }
  }
  queueStyle(el, prop, value);
  map.set(prop, value);
}

function flushStyleBatch(): void {
  for (const [el, props] of styleQueue) {
    for (const [prop, value] of props) el.style.setProperty(prop, value);
  }
  styleQueue.clear();
}

function promoteToGPU(el: HTMLElement): void {
  el.style.willChange = "transform, opacity, text-shadow, scale";
  el.style.backfaceVisibility = "hidden";
}

function promoteToGPUWithFilter(el: HTMLElement): void {
  if (gpuPromotedWithFilter.has(el)) return;
  el.style.willChange = "transform, opacity, text-shadow, scale, filter";
  el.style.backfaceVisibility = "hidden";
  gpuPromotedWithFilter.add(el);
}

export function getElementState(
  currentTime: number,
  startTime: number,
  endTime: number,
): SpicyElementStatus {
  if (currentTime < startTime) return "NotSung";
  if (currentTime >= endTime) return "Sung";
  return "Active";
}

function getProgressPercentage(currentTime: number, startTime: number, endTime: number): number {
  if (currentTime <= startTime) return 0;
  if (currentTime >= endTime) return 1;
  return (currentTime - startTime) / (endTime - startTime);
}

let blurringLastLine: number | null = null;
let lastFrameTime = performance.now();

export function resetSpicyAnimatorState(): void {
  blurringLastLine = null;
  lastFrameTime = performance.now();
  styleQueue.clear();
}

// Upstream's LyricsVirtualizer mount callback only invalidates the blur-line
// cache; it intentionally does not reset spring frame timing/state.
export function resetSpicyBlurState(): void {
  blurringLastLine = null;
}

export function timeSetter(
  lines: SpicyRuntimeLine[],
  position: number,
  lyricsType: SpicyLyricsType = "Syllable",
): void {
  const currentPosition = position;
  for (const line of lines) {
    const lineStatus = getElementState(currentPosition, line.StartTime, line.EndTime);
    line.Status = lineStatus;
    const words = line.Syllables?.Lead;
    if (!words) continue;

    if (lyricsType === "Line") {
      if (!line.DotLine) continue;
      for (const dot of words) {
        dot.Status = lineStatus === "Active"
          ? getElementState(currentPosition, dot.StartTime, dot.EndTime)
          : lineStatus;
      }
      continue;
    }

    if (lineStatus === "Active") {
      for (const word of words) {
        word.Status = getElementState(currentPosition, word.StartTime, word.EndTime);
        if (!word.LetterGroup || !word.Letters) continue;
        for (const letter of word.Letters) {
          letter.Status = getElementState(currentPosition, letter.StartTime, letter.EndTime);
        }
      }
    } else {
      for (const word of words) {
        word.Status = lineStatus;
        if (!word.LetterGroup || !word.Letters) continue;
        for (const letter of word.Letters) {
          letter.Status = lineStatus;
        }
      }
    }
  }
}

function applyBlur(lines: SpicyRuntimeLine[], activeIndex: number): void {
  if (!lines[activeIndex]) return;
  const max = BLUR_MULTIPLIER * 5 + BLUR_MULTIPLIER * 0.465;
  promoteToGPUWithFilter(lines[activeIndex].HTMLElement);
  for (let index = 0; index < lines.length; index += 1) {
    const el = lines[index].HTMLElement;
    if (!el.isConnected) continue;
    const state = getElementState(lastProcessedPosition, lines[index].StartTime, lines[index].EndTime);
    const distance = Math.abs(index - activeIndex);
    const blurAmount = distance === 0 ? 0 : Math.min(BLUR_MULTIPLIER * distance, max);
    const value = state === "Active" || distance === 0 ? "0px" : `${blurAmount}px`;
    setStyleIfChanged(el, "--BlurAmount", value, 0.25);
    promoteToGPUWithFilter(el);
  }
}

let lastProcessedPosition = 0;

function animateLetterGroup(word: SpicyWord, processedPosition: number, deltaTime: number): void {
  if (!word.Letters) return;
  const wordState = getElementState(processedPosition, word.StartTime, word.EndTime);

  if (wordState === "Active") {
    let activeLetterIndex = -1;
    let activeLetterPercentage = 0;
    for (let index = 0; index < word.Letters.length; index += 1) {
      const candidate = word.Letters[index];
      if (getElementState(processedPosition, candidate.StartTime, candidate.EndTime) === "Active") {
        activeLetterIndex = index;
        activeLetterPercentage = getProgressPercentage(
          processedPosition,
          candidate.StartTime,
          candidate.EndTime,
        );
        break;
      }
    }

    for (let index = 0; index < word.Letters.length; index += 1) {
      const letter = word.Letters[index];
      if (!letter.AnimatorStore) {
        letter.AnimatorStore = createLetterSprings();
        letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(0), true);
        letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(0), true);
        letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
        promoteToGPU(letter.HTMLElement);
      }

      let targetScale = LETTER_SCALE_SPLINE.at(0);
      let targetYOffset = LETTER_Y_OFFSET_SPLINE.at(0);
      let targetGlow = GLOW_SPLINE.at(0);
      const letterState = getElementState(processedPosition, letter.StartTime, letter.EndTime);

      if (activeLetterIndex !== -1) {
        const baseScale = LETTER_SCALE_SPLINE.at(activeLetterPercentage);
        const baseYOffset = LETTER_Y_OFFSET_SPLINE.at(activeLetterPercentage);
        const baseGlow = GLOW_SPLINE.at(activeLetterPercentage);
        const distance = Math.abs(index - activeLetterIndex);
        const falloff = Math.max(0, 1 / (1 + Math.pow(distance, 2.8)));
        const glowFalloff = Math.max(0, 1 / (1 + distance * 0.9));
        targetScale = LETTER_SCALE_SPLINE.at(0) + (baseScale - LETTER_SCALE_SPLINE.at(0)) * falloff;
        targetYOffset = LETTER_Y_OFFSET_SPLINE.at(0) + (baseYOffset - LETTER_Y_OFFSET_SPLINE.at(0)) * falloff;
        targetGlow = GLOW_SPLINE.at(0) + (baseGlow - GLOW_SPLINE.at(0)) * glowFalloff;
      }

      if (letterState === "NotSung") {
        targetScale = LETTER_SCALE_SPLINE.at(0);
        targetYOffset = LETTER_Y_OFFSET_SPLINE.at(0);
        targetGlow = GLOW_SPLINE.at(0);
      } else if (letterState === "Sung" && activeLetterIndex === -1) {
        targetGlow = GLOW_SPLINE.at(SUNG_LETTER_GLOW);
      }

      const targetGradient =
        letterState === "NotSung"
          ? -20
          : letterState === "Sung"
            ? 100
            : index === activeLetterIndex
              ? -20 + 120 * easeSinOut(activeLetterPercentage)
              : -20;

      letter.AnimatorStore.Scale.SetGoal(targetScale);
      letter.AnimatorStore.YOffset.SetGoal(targetYOffset);
      letter.AnimatorStore.Glow.SetGoal(targetGlow);
      const currentScale = letter.AnimatorStore.Scale.Step(deltaTime);
      const currentYOffset = letter.AnimatorStore.YOffset.Step(deltaTime);
      const currentGlow = letter.AnimatorStore.Glow.Step(deltaTime);
      letter.HTMLElement.style.setProperty("--gradient-position", `${targetGradient}%`);
      setStyleIfChanged(
        letter.HTMLElement,
        "transform",
        `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset * 2}), 0)`,
        0.001,
      );
      setStyleIfChanged(letter.HTMLElement, "scale", `${currentScale}`, 0.001);
      setStyleIfChanged(
        letter.HTMLElement,
        "--text-shadow-blur-radius",
        `${4 + 12 * currentGlow}px`,
        0.5,
      );
      setStyleIfChanged(
        letter.HTMLElement,
        "--text-shadow-opacity",
        `${currentGlow * LETTER_GLOW_MULTIPLIER_OPACITY}%`,
        1,
      );
    }
    return;
  }

  for (const letter of word.Letters) {
    if (!letter.AnimatorStore) {
      letter.AnimatorStore = createLetterSprings();
      letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(0), true);
      letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(0), true);
      letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
      promoteToGPU(letter.HTMLElement);
    }
    const sung = wordState === "Sung";
    letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(sung ? 1 : 0));
    letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(sung ? 1 : 0));
    letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(sung ? 1 : 0));
    const currentScale = letter.AnimatorStore.Scale.Step(deltaTime);
    const currentYOffset = letter.AnimatorStore.YOffset.Step(deltaTime);
    const currentGlow = letter.AnimatorStore.Glow.Step(deltaTime);
    letter.HTMLElement.style.setProperty("--gradient-position", sung ? "100%" : "-20%");
    setStyleIfChanged(
      letter.HTMLElement,
      "transform",
      `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset * 2}), 0)`,
      0.001,
    );
    setStyleIfChanged(letter.HTMLElement, "scale", `${currentScale}`, 0.001);
    setStyleIfChanged(letter.HTMLElement, "--text-shadow-blur-radius", `${4 + 12 * currentGlow}px`, 0.5);
    setStyleIfChanged(
      letter.HTMLElement,
      "--text-shadow-opacity",
      `${currentGlow * LETTER_GLOW_MULTIPLIER_OPACITY}%`,
      1,
    );
  }
}

function animateActiveWord(word: SpicyWord, processedPosition: number, deltaTime: number): void {
  const wordState = getElementState(processedPosition, word.StartTime, word.EndTime);
  const percentage = getProgressPercentage(processedPosition, word.StartTime, word.EndTime);

  if (word.Dot) {
    if (!word.AnimatorStore) {
      word.AnimatorStore = createDotSprings();
      word.AnimatorStore.Scale.SetGoal(DOT_SCALE_SPLINE.at(0), true);
      word.AnimatorStore.YOffset.SetGoal(DOT_Y_OFFSET_SPLINE.at(0), true);
      word.AnimatorStore.Glow.SetGoal(DOT_GLOW_SPLINE.at(0), true);
      word.AnimatorStore.Opacity?.SetGoal(DOT_OPACITY_SPLINE.at(0), true);
      promoteToGPU(word.HTMLElement);
    }
    const splinePosition = wordState === "NotSung" ? 0 : wordState === "Sung" ? 1 : percentage;
    word.AnimatorStore.Scale.SetGoal(DOT_SCALE_SPLINE.at(splinePosition));
    word.AnimatorStore.YOffset.SetGoal(DOT_Y_OFFSET_SPLINE.at(splinePosition));
    word.AnimatorStore.Glow.SetGoal(DOT_GLOW_SPLINE.at(splinePosition));
    word.AnimatorStore.Opacity?.SetGoal(DOT_OPACITY_SPLINE.at(splinePosition));
    const currentScale = word.AnimatorStore.Scale.Step(deltaTime);
    const currentYOffset = word.AnimatorStore.YOffset.Step(deltaTime);
    const currentGlow = word.AnimatorStore.Glow.Step(deltaTime);
    const currentOpacity = word.AnimatorStore.Opacity?.Step(deltaTime) ?? 1;
    setStyleIfChanged(
      word.HTMLElement,
      "transform",
      `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset}), 0)`,
      0.001,
    );
    setStyleIfChanged(word.HTMLElement, "scale", `${currentScale}`, 0.001);
    setStyleIfChanged(word.HTMLElement, "opacity", `${currentOpacity}`, 0.001);
    setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 6 * currentGlow}px`, 0.5);
    setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", `${currentGlow * 90}%`, 1);
    return;
  }

  if (!word.AnimatorStore) {
    word.AnimatorStore = createWordSprings();
    word.AnimatorStore.Scale.SetGoal(SCALE_SPLINE.at(0), true);
    word.AnimatorStore.YOffset.SetGoal(Y_OFFSET_SPLINE.at(0), true);
    word.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
    promoteToGPU(word.HTMLElement);
  }
  const splinePosition = wordState === "NotSung" ? 0 : wordState === "Sung" ? 1 : percentage;
  const targetGradient = wordState === "NotSung" ? -20 : wordState === "Sung" ? 100 : -20 + 120 * percentage;
  word.AnimatorStore.Scale.SetGoal(SCALE_SPLINE.at(splinePosition));
  word.AnimatorStore.YOffset.SetGoal(Y_OFFSET_SPLINE.at(splinePosition));
  word.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(splinePosition));
  const currentScale = word.AnimatorStore.Scale.Step(deltaTime);
  const currentYOffset = word.AnimatorStore.YOffset.Step(deltaTime);
  const currentGlow = word.AnimatorStore.Glow.Step(deltaTime);
  setStyleIfChanged(word.HTMLElement, "scale", `${currentScale}`, 0.001);
  setStyleIfChanged(
    word.HTMLElement,
    "transform",
    `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset}), 0)`,
    0.001,
  );
  if (!word.LetterGroup) {
    word.HTMLElement.style.setProperty("--gradient-position", `${targetGradient}%`);
    setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 2 * currentGlow}px`, 0.5);
    setStyleIfChanged(
      word.HTMLElement,
      "--text-shadow-opacity",
      `${Math.min(currentGlow * 35, 100)}%`,
      1,
    );
  }
  if (word.LetterGroup) animateLetterGroup(word, processedPosition, deltaTime);
}

function settleSungWord(word: SpicyWord, deltaTime: number): void {
  if (word.AnimatorStore && !word.Dot) {
    word.AnimatorStore.Scale.SetGoal(SCALE_SPLINE.at(1));
    word.AnimatorStore.YOffset.SetGoal(Y_OFFSET_SPLINE.at(1));
    word.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(1));
    const currentScale = word.AnimatorStore.Scale.Step(deltaTime);
    const currentYOffset = word.AnimatorStore.YOffset.Step(deltaTime);
    const currentGlow = word.AnimatorStore.Glow.Step(deltaTime);
    setStyleIfChanged(
      word.HTMLElement,
      "transform",
      `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset}), 0)`,
      0.001,
    );
    setStyleIfChanged(word.HTMLElement, "scale", `${currentScale}`, 0.001);
    if (!word.LetterGroup) {
      word.HTMLElement.style.setProperty("--gradient-position", "100%");
      setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 2 * currentGlow}px`, 0.5);
      setStyleIfChanged(
        word.HTMLElement,
        "--text-shadow-opacity",
        `${Math.min(currentGlow * 35, 100)}%`,
        1,
      );
    }
  } else if (word.AnimatorStore && word.Dot) {
    word.AnimatorStore.Scale.SetGoal(DOT_SCALE_SPLINE.at(1));
    word.AnimatorStore.YOffset.SetGoal(DOT_Y_OFFSET_SPLINE.at(1));
    word.AnimatorStore.Glow.SetGoal(DOT_GLOW_SPLINE.at(1));
    word.AnimatorStore.Opacity?.SetGoal(DOT_OPACITY_SPLINE.at(1));
    const currentScale = word.AnimatorStore.Scale.Step(deltaTime);
    const currentYOffset = word.AnimatorStore.YOffset.Step(deltaTime);
    const currentGlow = word.AnimatorStore.Glow.Step(deltaTime);
    const currentOpacity = word.AnimatorStore.Opacity?.Step(deltaTime) ?? 1;
    setStyleIfChanged(
      word.HTMLElement,
      "transform",
      `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset}), 0)`,
      0.001,
    );
    setStyleIfChanged(word.HTMLElement, "scale", `${currentScale}`, 0.001);
    setStyleIfChanged(word.HTMLElement, "opacity", `${currentOpacity}`, 0.001);
    setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 6 * currentGlow}px`, 0.5);
    setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", `${currentGlow * 90}%`, 1);
  }

  if (word.LetterGroup && word.Letters) {
    for (const letter of word.Letters) {
      if (!letter.AnimatorStore) {
        letter.AnimatorStore = createLetterSprings();
        letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(0), true);
        letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(0), true);
        letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
      }
      letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(1));
      letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(1));
      letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(1));
      const currentScale = letter.AnimatorStore.Scale.Step(deltaTime);
      const currentYOffset = letter.AnimatorStore.YOffset.Step(deltaTime);
      const currentGlow = letter.AnimatorStore.Glow.Step(deltaTime);
      letter.HTMLElement.style.setProperty("--gradient-position", "100%");
      setStyleIfChanged(
        letter.HTMLElement,
        "transform",
        `translate3d(0, calc(var(--DefaultLyricsSize) * ${currentYOffset * 2}), 0)`,
        0.001,
      );
      setStyleIfChanged(letter.HTMLElement, "scale", `${currentScale}`, 0.001);
      letter.HTMLElement.style.setProperty("--text-shadow-blur-radius", `${4 + 12 * currentGlow}px`);
      letter.HTMLElement.style.setProperty(
        "--text-shadow-opacity",
        `${currentGlow * LETTER_GLOW_MULTIPLIER_OPACITY}%`,
      );
    }
  }
}

function animateLineLyrics(
  lines: SpicyRuntimeLine[],
  processedPosition: number,
  deltaTime: number,
): void {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.HTMLElement.isConnected) continue;
    const lineState = getElementState(processedPosition, line.StartTime, line.EndTime);

    if (lineState === "Active") {
      if (blurringLastLine !== index) {
        applyBlur(lines, index);
        blurringLastLine = index;
      }
      line.HTMLElement.classList.add("Active");
      line.HTMLElement.classList.remove("NotSung", "Sung");

      if (line.DotLine) {
        line.HTMLElement.classList.toggle(
          "pre-hidden",
          processedPosition > line.EndTime - PRE_HIDDEN_DOT_LINE_MS,
        );
        for (const dot of line.Syllables?.Lead || []) {
          animateActiveWord(dot, processedPosition, deltaTime);
        }
      } else {
        const percentage = getProgressPercentage(processedPosition, line.StartTime, line.EndTime);
        if (!line.AnimatorStore) {
          line.AnimatorStore = createLineSprings();
          line.AnimatorStore.Glow.SetGoal(LINE_GLOW_SPLINE.at(0), true);
        }
        line.AnimatorStore.Glow.SetGoal(LINE_GLOW_SPLINE.at(percentage));
        const currentGlow = line.AnimatorStore.Glow.Step(deltaTime);
        line.HTMLElement.style.setProperty("--gradient-position", `${percentage * 100}%`);
        setStyleIfChanged(
          line.HTMLElement,
          "--text-shadow-blur-radius",
          `${4 + 8 * currentGlow}px`,
          0.5,
        );
        setStyleIfChanged(
          line.HTMLElement,
          "--text-shadow-opacity",
          `${currentGlow * 50}%`,
          1,
        );
      }
    } else if (lineState === "NotSung") {
      line.HTMLElement.classList.add("NotSung");
      line.HTMLElement.classList.remove("Sung", "Active");
      if (line.DotLine) line.HTMLElement.classList.add("pre-hidden");
    } else {
      line.HTMLElement.classList.add("Sung");
      line.HTMLElement.classList.remove("Active", "NotSung");
      if (line.DotLine) line.HTMLElement.classList.remove("pre-hidden");
    }
  }
}

export function animate(
  lines: SpicyRuntimeLine[],
  position: number,
  lyricsType: SpicyLyricsType = "Syllable",
): void {
  const processedPosition = position;
  lastProcessedPosition = processedPosition;
  const now = performance.now();
  const deltaTime = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  if (lyricsType === "Line") {
    animateLineLyrics(lines, processedPosition, deltaTime);
    flushStyleBatch();
    return;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.HTMLElement.isConnected) continue;
    const lineState = getElementState(processedPosition, line.StartTime, line.EndTime);

    if (lineState === "Active") {
      if (blurringLastLine !== index) {
        applyBlur(lines, index);
        blurringLastLine = index;
      }
      line.HTMLElement.classList.add("Active");
      line.HTMLElement.classList.remove("NotSung", "Sung");
      if (line.DotLine) {
        line.HTMLElement.classList.toggle(
          "pre-hidden",
          processedPosition > line.EndTime - PRE_HIDDEN_DOT_LINE_MS,
        );
      }
      for (const word of line.Syllables?.Lead || []) {
        animateActiveWord(word, processedPosition, deltaTime);
      }
    } else if (lineState === "NotSung") {
      line.HTMLElement.classList.add("NotSung");
      line.HTMLElement.classList.remove("Sung", "Active");
      if (line.DotLine) line.HTMLElement.classList.add("pre-hidden");
      // Upstream intentionally does not step/reset word stores in this branch.
    } else {
      line.HTMLElement.classList.add("Sung");
      line.HTMLElement.classList.remove("Active", "NotSung");
      if (line.DotLine) line.HTMLElement.classList.remove("pre-hidden");

      const nextLine = lines[index + 1];
      const nextStatus = nextLine
        ? getElementState(processedPosition, nextLine.StartTime, nextLine.EndTime)
        : undefined;
      if (!nextLine || nextStatus === "NotSung" || nextStatus === "Active") {
        for (const word of line.Syllables?.Lead || []) settleSungWord(word, deltaTime);
      }
    }
  }

  flushStyleBatch();
}

export const SPICY_INTERLUDE_GAP_MS = 3000;
export const SPICY_PREHIDDEN_DOT_LINE_MS = PRE_HIDDEN_DOT_LINE_MS;
export const SPICY_INTERLUDE_TIME_PADDING_MS = -(PRE_HIDDEN_DOT_LINE_MS + 50);

export function createDotTiming(startTime: number, endTime: number): [number, number][] {
  const totalTime = Math.max(1, endTime - startTime);
  const baseDotTime = totalTime / 3;
  const dotPadding = SPICY_INTERLUDE_TIME_PADDING_MS / 3;
  const dot1EndTime = Math.max(startTime, startTime + baseDotTime + dotPadding);
  const dot2EndTime = Math.max(
    dot1EndTime,
    startTime + baseDotTime * 2 + dotPadding * 2,
  );
  const dot3EndTime = Math.max(
    dot2EndTime,
    startTime + totalTime + SPICY_INTERLUDE_TIME_PADDING_MS,
  );
  return [
    [startTime, dot1EndTime],
    [dot1EndTime, dot2EndTime],
    [dot2EndTime, dot3EndTime],
  ];
}
