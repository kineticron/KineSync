import { useEffect } from 'react';
import { useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { clamp01, stepAmllSpring } from './reference-motion';
export type ReferenceLineMotion = { scale: number; velocity: number; bright: number; dark: number };

/** AMLL line scale springs and asymmetric alpha attack/release, in reference units. */
export function useReferenceLineMotion(activeLine: SharedValue<boolean>, enabled: boolean, background: boolean, playing: boolean) {
  const motion = useSharedValue<ReferenceLineMotion>({ scale: 1, velocity: 0, bright: 1, dark: 0.4 });
  const running = useSharedValue(false);
  const pending = useSharedValue(-1);
  const clock = useSharedValue({ timestamp: -1, delta: 0 });
  useEffect(() => {
    running.value = enabled;
    return () => scheduleOnUI(() => {
      'worklet';
      running.value = false;
      cancelAnimationFrame(pending.value);
      pending.value = -1;
    });
  }, [enabled, pending, running]);
  useAnimatedReaction(() => ({ active: activeLine.value, line: activeLine, enabled: running.value, background, playing }), (next, previous) => {
    'worklet';
    // An in-flight loop already reads the latest active line on the UI runtime.
    if (next.enabled && pending.value !== -1 && previous && next.line === previous.line && next.background === previous.background && next.playing === previous.playing) return;
    cancelAnimationFrame(pending.value);
    pending.value = -1;
    if (!next.enabled) return;
    const reset = !previous || !previous.enabled || next.line !== previous.line || next.background !== previous.background || next.playing !== previous.playing;
    // A suspended frame may settle the loop with a delta too large for the next cue.
    clock.value = { timestamp: -1, delta: reset || clock.value.delta > 0.064 ? 0 : clock.value.delta };
    function tick(timestamp: number) {
      'worklet';
      if (!running.value) return;
      const current = motion.value;
      const active = activeLine.value;
      const target = active || !playing ? 1 : background ? 0.75 : 0.97;
      // Reuse one frame's delta on wake, never the full time spent asleep.
      const dt = clock.value.timestamp < 0 ? clock.value.delta : Math.max(0, (timestamp - clock.value.timestamp) / 1000);
      clock.value = { timestamp, delta: dt };
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
      pending.value = dt > 0 && scale === target && Math.abs(spring.v) < 0.0001 && bright === brightTarget && dark === darkTarget
        ? -1 : requestAnimationFrame(tick);
    }
    pending.value = requestAnimationFrame(tick);
  });
  return motion;
}
