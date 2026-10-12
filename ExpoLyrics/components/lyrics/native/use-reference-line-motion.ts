import { useCallback, useEffect } from 'react';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { clamp01, stepAmllSpring } from './reference-motion';
export type ReferenceLineMotion = { scale: number; velocity: number; bright: number; dark: number };

/** AMLL line scale springs and asymmetric alpha attack/release, in reference units. */
export function useReferenceLineMotion(activeLine: SharedValue<boolean>, enabled: boolean, background: boolean, playing: boolean) {
  const motion = useSharedValue<ReferenceLineMotion>({ scale: 1, velocity: 0, bright: 1, dark: 0.4 });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const current = motion.value;
    const active = activeLine.value;
    const target = active || !playing ? 1 : background ? 0.75 : 0.97;
    const dt = Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000);
    const spring = stepAmllSpring({ p: current.scale, v: current.velocity }, target, background ? 1 : 2, background ? 20 : 25, background ? 50 : 100, dt);
    const scale = Math.abs(spring.p - target) < 0.0001 && Math.abs(spring.v) < 0.0001 ? target : spring.p;
    const factor = clamp01((scale - 0.97) / 0.03);
    const brightTarget = active ? factor * 0.8 + 0.2 : factor * 0.2 + 0.2;
    const darkTarget = factor * 0.2 + 0.2;
    const bright = Math.abs(brightTarget - current.bright) < 0.001 ? brightTarget
      : current.bright + (brightTarget - current.bright) * (1 - Math.exp(-(brightTarget > current.bright ? 50 : 7) * (dt || 0.016)));
    const dark = Math.abs(darkTarget - current.dark) < 0.001 ? darkTarget
      : current.dark + (darkTarget - current.dark) * (1 - Math.exp(-(darkTarget > current.dark ? 50 : 7) * (dt || 0.016)));
    if (scale !== current.scale || bright !== current.bright || dark !== current.dark)
      motion.value = { scale, velocity: spring.v, bright, dark };
  }, [activeLine, background, motion, playing]), false);
  useEffect(() => { frame.setActive(enabled); return () => frame.setActive(false); }, [enabled, frame]);
  return motion;
}
