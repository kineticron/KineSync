/*
 * Spicy Lyrics v6.3.15 word and dot motion reference for the Skia parity checks.
 * Source: Spikerko/spicy-lyrics @ 2a14863f8c29782f9ab3becff2b1360dfb74a4fb (AGPL-3.0).
 */
import Spline from "cubic-spline";

export type SpicyElementStatus = "NotSung" | "Active" | "Sung";

export type SpicyAnimatorStore = {
  Scale: Spring;
  YOffset: Spring;
  Glow: Spring;
  Opacity?: Spring;
};

export type SpicyLetter = {
  StartTime: number;
  EndTime: number;
  TotalTime: number;
  Status?: SpicyElementStatus;
  AnimatorStore?: SpicyAnimatorStore;
  Emphasis?: boolean;
  BGLetter?: boolean;
};

export type SpicyWord = {
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

const SLEEP_OFFSET_SQ_LIMIT = (1 / 3840) ** 2;
const SLEEP_VELOCITY_SQ_LIMIT = 1e-2 ** 2;
const EPS = 1e-5;
let snapSprings = false;

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
    if (snapSprings || this.CanSleep()) {
      this.p = this.g;
      this.v = 0;
      return this.p;
    }
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

const PRE_HIDDEN_DOT_LINE_MS = 500;
const SUNG_LETTER_GLOW = 0.2;
const Y_OFFSET_DAMPING = 0.4;
const Y_OFFSET_FREQUENCY = 1.45;
const SCALE_DAMPING = 0.64;
const SCALE_FREQUENCY = 0.88;
const GLOW_DAMPING = 0.56;
const GLOW_FREQUENCY = 1.18;
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

      letter.AnimatorStore.Scale.SetGoal(targetScale);
      letter.AnimatorStore.YOffset.SetGoal(targetYOffset);
      letter.AnimatorStore.Glow.SetGoal(targetGlow);
      letter.AnimatorStore.Scale.Step(deltaTime);
      letter.AnimatorStore.YOffset.Step(deltaTime);
      letter.AnimatorStore.Glow.Step(deltaTime);
    }
    return;
  }

  for (const letter of word.Letters) {
    if (!letter.AnimatorStore) {
      letter.AnimatorStore = createLetterSprings();
      letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(0), true);
      letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(0), true);
      letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
    }
    const sung = wordState === "Sung";
    letter.AnimatorStore.Scale.SetGoal(LETTER_SCALE_SPLINE.at(sung ? 1 : 0));
    letter.AnimatorStore.YOffset.SetGoal(LETTER_Y_OFFSET_SPLINE.at(sung ? 1 : 0));
    letter.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(sung ? 1 : 0));
    letter.AnimatorStore.Scale.Step(deltaTime);
    letter.AnimatorStore.YOffset.Step(deltaTime);
    letter.AnimatorStore.Glow.Step(deltaTime);
  }
}

export function animateActiveWord(word: SpicyWord, processedPosition: number, deltaTime: number): void {
  const wordState = getElementState(processedPosition, word.StartTime, word.EndTime);
  const percentage = getProgressPercentage(processedPosition, word.StartTime, word.EndTime);

  if (word.Dot) {
    if (!word.AnimatorStore) {
      word.AnimatorStore = createDotSprings();
      word.AnimatorStore.Scale.SetGoal(DOT_SCALE_SPLINE.at(0), true);
      word.AnimatorStore.YOffset.SetGoal(DOT_Y_OFFSET_SPLINE.at(0), true);
      word.AnimatorStore.Glow.SetGoal(DOT_GLOW_SPLINE.at(0), true);
      word.AnimatorStore.Opacity?.SetGoal(DOT_OPACITY_SPLINE.at(0), true);
    }
    const splinePosition = wordState === "NotSung" ? 0 : wordState === "Sung" ? 1 : percentage;
    word.AnimatorStore.Scale.SetGoal(DOT_SCALE_SPLINE.at(splinePosition));
    word.AnimatorStore.YOffset.SetGoal(DOT_Y_OFFSET_SPLINE.at(splinePosition));
    word.AnimatorStore.Glow.SetGoal(DOT_GLOW_SPLINE.at(splinePosition));
    word.AnimatorStore.Opacity?.SetGoal(DOT_OPACITY_SPLINE.at(splinePosition));
    word.AnimatorStore.Scale.Step(deltaTime);
    word.AnimatorStore.YOffset.Step(deltaTime);
    word.AnimatorStore.Glow.Step(deltaTime);
    word.AnimatorStore.Opacity?.Step(deltaTime);
    return;
  }

  if (!word.AnimatorStore) {
    word.AnimatorStore = createWordSprings();
    word.AnimatorStore.Scale.SetGoal(SCALE_SPLINE.at(0), true);
    word.AnimatorStore.YOffset.SetGoal(Y_OFFSET_SPLINE.at(0), true);
    word.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(0), true);
  }
  const splinePosition = wordState === "NotSung" ? 0 : wordState === "Sung" ? 1 : percentage;

  word.AnimatorStore.Scale.SetGoal(SCALE_SPLINE.at(splinePosition));
  word.AnimatorStore.YOffset.SetGoal(Y_OFFSET_SPLINE.at(splinePosition));
  word.AnimatorStore.Glow.SetGoal(GLOW_SPLINE.at(splinePosition));
  word.AnimatorStore.Scale.Step(deltaTime);
  word.AnimatorStore.YOffset.Step(deltaTime);
  word.AnimatorStore.Glow.Step(deltaTime);

  if (word.LetterGroup) animateLetterGroup(word, processedPosition, deltaTime);
}

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

export { SCALE_SPLINE, LETTER_SCALE_SPLINE, Y_OFFSET_SPLINE, LETTER_Y_OFFSET_SPLINE, GLOW_SPLINE,
  DOT_SCALE_SPLINE, DOT_Y_OFFSET_SPLINE, DOT_GLOW_SPLINE, DOT_OPACITY_SPLINE };
