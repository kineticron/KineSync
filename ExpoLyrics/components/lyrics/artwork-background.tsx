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
  const layoutReady = size.width > 0 && size.height > 0;
  const renderSize = useMemo(() => kawarpRenderSize(size.width, size.height, density), [density, size.height, size.width]);
  const preparationSize = useRef(renderSize);
  preparationSize.current = renderSize;
  const canvasBoundsStyle = useMemo(() => ({ position: 'absolute' as const,
    left: -renderSize.bleed, top: -renderSize.bleed, right: -renderSize.bleed, bottom: -renderSize.bleed }), [renderSize.bleed]);
  const canvasStyle = useMemo(() => ({
    width: `${100 / renderSize.scale}%` as const, height: `${100 / renderSize.scale}%` as const, transformOrigin: 'top left',
    transform: [{ scale: renderSize.scale }] }), [renderSize]);
  // Keep onSize registered even while hidden: useFrameCallback retains its initial
  // active state, so mounting without onSize can strand measurement at zero.
  // Skia measures on the UI thread. Reanimated's Fabric measure includes the
  // display transform; undo our scale to recover the backing surface's points.
  // Delayed/unavailable native measurement must never collapse the prepared
  // image destination or live shader resolution to a single point.
  const canvasSize = useSharedValue({ width: 0, height: 0 });
  const canvasWidth = useDerivedValue(() => canvasSize.get().width > 0 ? Math.max(1, Math.floor(canvasSize.get().width / renderSize.scale)) : renderSize.width);
  const canvasHeight = useDerivedValue(() => canvasSize.get().height > 0 ? Math.max(1, Math.floor(canvasSize.get().height / renderSize.scale)) : renderSize.height);
  const uniforms = useDerivedValue(() => ({ resolution: [canvasWidth.get(), canvasHeight.get()], time: time.get(), blend: 1 }));

  useEffect(() => {
    const app = AppState.addEventListener('change', state => setForeground(state === 'active'));
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { app.remove(); motion.remove(); };
  }, []);

  useEffect(() => {
    if (!uri || !layoutReady) return;
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
        const frameSize = preparationSize.current;
        const prepared = await prepareKawarpArtwork(data, old && {
          texture: old.texture, frame: old.frame, previousFrame: old.previousFrame, effects: old.effects,
        }, progress, time.get(), frameSize.width, frameSize.height, density);
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
  }, [density, layoutReady, time, uri]);

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
      {layoutReady ? <View style={canvasBoundsStyle}><Canvas style={canvasStyle} onSize={canvasSize}>
        {scene ? transitioning ? <>
          {scene.previousFrame ? <Image image={scene.previousFrame} x={0} y={0} width={canvasWidth} height={canvasHeight} fit="fill" sampling={SAMPLING} /> : null}
          <Image image={scene.frame} x={0} y={0} width={canvasWidth} height={canvasHeight} fit="fill" sampling={SAMPLING} opacity={scene.blend} />
        </> : <Fill><Shader source={scene.effects.warp} uniforms={uniforms}>
          <ImageShader image={scene.texture} width={KAWARP_TEXTURE_SIZE} height={KAWARP_TEXTURE_SIZE} fit="fill" sampling={SAMPLING} />
          <ImageShader image={scene.texture} width={KAWARP_TEXTURE_SIZE} height={KAWARP_TEXTURE_SIZE} fit="fill" sampling={SAMPLING} />
        </Shader></Fill> : null}
      </Canvas></View> : null}
    </Animated.View>
  </View>;
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: '#0A0B11' },
});
