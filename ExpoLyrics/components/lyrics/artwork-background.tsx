import { Canvas, Fill, FilterMode, Image, ImageShader, MipmapMode, Shader, Skia, type SkData } from '@shopify/react-native-skia';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  cancelAnimation, Easing, makeMutable, useAnimatedStyle, useDerivedValue, useFrameCallback, useReducedMotion,
  useSharedValue, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { LaunchVisibilityContext } from '@/components/ui/launch-visibility';
import { PromotionalBackdrop } from '@/components/ui/promotional-backdrop';
import { ArtworkBackgroundFallback, type ArtworkBackgroundProps } from './artwork-background-fallback';
import { kawarpRenderSize, KAWARP_FRAME_MS, KAWARP_TEXTURE_SIZE, KAWARP_TRANSITION_MS } from './kawarp-shaders';
import { prepareKawarpArtwork, type PreparedArtwork } from './kawarp-artwork-loader';

type Scene = PreparedArtwork & { blend: SharedValue<number>; generation: number };
const SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None } as const;
const TRANSITION_EASE = Easing.bezier(0.45, 0, 0.55, 1);

export const ArtworkBackground = memo(function ArtworkBackground({ uri, playing, active }: ArtworkBackgroundProps) {
  const launchVisible = useContext(LaunchVisibilityContext);
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scene, setScene] = useState<Scene | null>(null);
  const [failed, setFailed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [transitioning, setTransitioning] = useState(true);
  const sceneRef = useRef<Scene | null>(null);
  const encoded = useRef<{ uri: string; data: SkData } | null>(null);
  const time = useSharedValue(0);
  const elapsed = useSharedValue(0);
  const appearance = useSharedValue(1);
  const visible = active && foreground && launchVisible;
  const density = PixelRatio.get();
  const renderSize = useMemo(() => kawarpRenderSize(size.width, size.height, density), [density, size.height, size.width]);
  const canvasStyle = useMemo(() => ({ position: 'absolute' as const, left: -renderSize.bleed, top: -renderSize.bleed,
    width: renderSize.width, height: renderSize.height, transformOrigin: 'top left',
    transform: [{ scale: renderSize.scale }] }), [renderSize]);
  const uniforms = useDerivedValue(() => ({ resolution: [renderSize.width, renderSize.height], time: time.get(), blend: 1 }));

  useEffect(() => {
    const app = AppState.addEventListener('change', state => setForeground(state === 'active'));
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { app.remove(); motion.remove(); };
  }, []);

  useEffect(() => {
    if (!uri || size.width <= 0 || size.height <= 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setFailed(false);
    async function load() {
      try {
        let data = encoded.current?.uri === uri ? encoded.current.data : null;
        if (!data) {
          const response = uri.startsWith('data:') ? null : await fetch(uri, { signal: controller.signal });
          if (response && !response.ok) throw new Error('Cannot fetch artwork background');
          data = uri.startsWith('data:')
            ? Skia.Data.fromBase64(uri.slice(uri.indexOf(',') + 1))
            : Skia.Data.fromBytes(new Uint8Array(await response!.arrayBuffer()));
          if (cancelled) return;
          encoded.current = { uri, data };
        }
        if (cancelled) return;
        setPreparing(true);
        const old = sceneRef.current;
        if (old) cancelAnimation(old.blend);
        const progress = old?.blend.get() ?? 1;
        const prepared = await prepareKawarpArtwork(data, old && {
          texture: old.texture, frame: old.frame, previousFrame: old.previousFrame, effects: old.effects,
        }, progress, time.get(), renderSize.width, renderSize.height, density);
        if (cancelled) return;
        const next = { ...prepared, blend: makeMutable(0), generation: (old?.generation ?? 0) + 1 };
        sceneRef.current = next;
        setTransitioning(true);
        setScene(next);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setPreparing(false);
      }
    }
    void load();
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); };
  }, [density, renderSize.height, renderSize.width, size.height, size.width, time, uri]);

  const finishFade = useCallback((generation: number) => {
    if (sceneRef.current?.generation === generation) setTransitioning(false);
  }, []);
  useEffect(() => {
    if (!scene || preparing) return;
    const { blend, generation } = scene;
    if (visible && !reducedMotion && blend.get() < 1) {
      blend.set(withTiming(1, { duration: KAWARP_TRANSITION_MS, easing: TRANSITION_EASE }, finished => {
        if (finished) scheduleOnRN(finishFade, generation);
      }));
    } else { blend.set(1); finishFade(generation); }
    return () => cancelAnimation(blend);
  }, [finishFade, preparing, reducedMotion, scene, visible]);

  useEffect(() => {
    const target = uri && !failed ? 1 : 0;
    appearance.set(visible && !reducedMotion
      ? withTiming(target, { duration: KAWARP_TRANSITION_MS, easing: TRANSITION_EASE }) : target);
    return () => cancelAnimation(appearance);
  }, [appearance, failed, reducedMotion, uri, visible]);
  const appearanceStyle = useAnimatedStyle(() => ({ opacity: appearance.get() }));

  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    elapsed.set(elapsed.get() + Math.min(64, info.timeSincePreviousFrame ?? 0));
    if (elapsed.get() < KAWARP_FRAME_MS - 0.5) return;
    time.set(time.get() + elapsed.get() / 1000);
    elapsed.set(0);
  }, [elapsed, time]), false);
  useEffect(() => {
    elapsed.set(0);
    frame.setActive(visible && playing && !reducedMotion && !!scene && !!uri && !failed && !preparing && !transitioning);
    return () => frame.setActive(false);
  }, [elapsed, failed, frame, playing, preparing, reducedMotion, scene, transitioning, uri, visible]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize(old => old.width === width && old.height === height ? old : { width, height });
  }, []);

  if (failed && !scene) return <ArtworkBackgroundFallback uri={uri} playing={playing} active={active} />;
  return <View pointerEvents="none" aria-hidden onLayout={onLayout} style={styles.root}>
    <PromotionalBackdrop />
    <Animated.View style={[StyleSheet.absoluteFill, appearanceStyle]}>
      {size.width > 0 && size.height > 0 ? <Canvas style={canvasStyle}>
        {scene ? transitioning ? <>
          {scene.previousFrame ? <Image image={scene.previousFrame} x={0} y={0} width={renderSize.width} height={renderSize.height} fit="fill" sampling={SAMPLING} /> : null}
          <Image image={scene.frame} x={0} y={0} width={renderSize.width} height={renderSize.height} fit="fill" sampling={SAMPLING} opacity={scene.blend} />
        </> : <Fill><Shader source={scene.effects.warp} uniforms={uniforms}>
          <ImageShader image={scene.texture} width={KAWARP_TEXTURE_SIZE} height={KAWARP_TEXTURE_SIZE} fit="fill" sampling={SAMPLING} />
          <ImageShader image={scene.texture} width={KAWARP_TEXTURE_SIZE} height={KAWARP_TEXTURE_SIZE} fit="fill" sampling={SAMPLING} />
        </Shader></Fill> : null}
      </Canvas> : null}
    </Animated.View>
  </View>;
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: '#0A0B11' },
});
