import { memo, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Design } from '@/constants/design';
import { nextUntimedWord, openUnit, unitSeparator, type StudioLine } from '@/lib/sync-studio/engine';
import { barPosition, characters, freeZoneFraction, highlightedCharacters, lineComplete, lineProgress, reachedWord, scrubPlan } from '@/lib/sync-studio/swipe';

type Props = {
  line: StudioLine;
  method: 'tap' | 'swipe';
  /** Tap keys, as in Spicy Lyrics' TTML tool: F starts a unit, G ends it and starts the next, H ends it. */
  onStart: () => void;
  onCommit: () => void;
  onEnd: () => void;
  /** Tap mode: the unit picked to resync on its own, and picking one (tap a word in the line). */
  focus?: number | null;
  onPickUnit?: (unit: number) => void;
  /** Slide: the finger went down on the bar (a new pass for this line). */
  onSwipeBegin: () => void;
  /** Slide: the highlighter reached `wordIndex`; `fromIndex` is the word reached before (-1 at first). */
  onSwipeEnter: (wordIndex: number, fromIndex: number) => void;
  /** Slide: the highlighter passed the last character of the line. */
  onSwipeComplete: (lastIndex: number) => void;
  /** Slide: moved back; words after `wordIndex` lost every lit letter and must be re-timed (-1: all). */
  onSwipeRetreat: (wordIndex: number) => void;
  /** Slide: finger lifted. */
  onSwipeEnd: (result: { completed: boolean; moved: boolean }) => void;
};

const THUMB = 46;

const KEYS = [
  { key: 'F', label: 'Start', hint: 'Start the next word' },
  { key: 'G', label: 'Commit', hint: 'End this word and start the next one' },
  { key: 'H', label: 'End', hint: 'End this word' },
] as const;

/**
 * The current line, big, with each unit (word or syllable, shown as some·thing)
 * green once synced and blue while it is being synced. Tap mode: three keys,
 * Start, Commit and End. Slide mode: hold the bar and slide right; the
 * highlighter lights the line letter by letter and each unit is synced as its
 * last letter lights up.
 */
export const WordPad = memo(function WordPad({ line, method, onStart, onCommit, onEnd, focus = null, onPickUnit, onSwipeBegin, onSwipeEnter, onSwipeComplete, onSwipeRetreat, onSwipeEnd }: Props) {
  const plan = useMemo(() => scrubPlan(line.words.map((word) => word.text)), [line.words]);
  const chars = useMemo(() => line.words.map((word) => characters(word.text)), [line.words]);
  const [lit, setLit] = useState<number | null>(null);
  const [puck, setPuck] = useState({ position: 0, free: 0 });
  const width = useRef(0);
  const pass = useRef({ startX: 0, last: -1, completed: false, moved: false });
  const next = nextUntimedWord(line);
  const open = openUnit(line);
  const done = line.words.length > 0 && next < 0 && line.words.at(-1)?.end != null;
  const fontSize = line.background ? 19 : 24;

  const slide = useMemo(() => Gesture.Pan().runOnJS(true).minDistance(0).shouldCancelWhenOutside(false)
    .onBegin((event) => {
      pass.current = { startX: event.x, last: -1, completed: false, moved: false };
      setLit(0);
      setPuck({ position: 0, free: freeZoneFraction(event.x, width.current) });
      onSwipeBegin();
    })
    .onUpdate((event) => {
      const state = pass.current;
      // The puck goes both ways. The first stretch (the free zone) lights nothing.
      const position = barPosition(event.x, state.startX, width.current);
      const lighted = highlightedCharacters(plan, lineProgress(position, state.startX, width.current));
      if (lighted > 0) state.moved = true;
      setLit(lighted);
      setPuck((current) => ({ ...current, position }));
      const reached = reachedWord(plan, lighted);
      if (reached > state.last) { onSwipeEnter(reached, state.last); state.last = reached; }
      // Back off every letter of a word and it is open to re-timing.
      else if (reached < state.last) { onSwipeRetreat(reached); state.last = reached; state.completed = false; }
      const complete = lineComplete(plan, lighted);
      if (!state.completed && complete) { state.completed = true; onSwipeComplete(state.last); }
      else if (state.completed && !complete) { state.completed = false; onSwipeRetreat(state.last); }
    })
    .onFinalize(() => {
      const { completed, moved } = pass.current;
      setLit(null);
      onSwipeEnd({ completed, moved });
    }), [onSwipeBegin, onSwipeComplete, onSwipeEnd, onSwipeEnter, onSwipeRetreat, plan]);

  // Characters lit per unit: live during a pass, otherwise from the saved timing.
  const litFor = (index: number) => lit != null
    ? Math.max(0, Math.min(chars[index].length, Math.floor(lit - plan.starts[index] + 1e-6)))
    : line.words[index].end != null ? chars[index].length : 0;

  const text = <Text allowFontScaling={false} style={[styles.line, { fontSize, lineHeight: fontSize * 1.35 }, line.background && styles.adLib]}>
    {line.words.map((word, index) => {
      // Tap mode: a unit being sung is blue, a picked one is outlined in gold,
      // and the next one to start is underlined. Tapping a unit picks it to resync.
      const tap = method === 'tap' && lit == null;
      const pick = tap && onPickUnit ? () => onPickUnit(index) : undefined;
      const singing = word.start != null && word.end == null;
      if (tap && (singing || index === focus)) {
        return <Text key={index} onPress={pick} suppressHighlighting>
          <Text style={[singing ? styles.syncing : styles.picked, index === focus && styles.pickedLine]}>{chars[index].join('')}</Text>{unitSeparator(line, index)}
        </Text>;
      }
      const count = litFor(index);
      const upcoming = tap && focus == null && open < 0 && index === next;
      return <Text key={index} onPress={pick} suppressHighlighting>
        {count ? <Text style={styles.lit}>{chars[index].slice(0, count).join('')}</Text> : null}
        <Text style={upcoming ? styles.next : undefined}>{chars[index].slice(count).join('')}</Text>
        {unitSeparator(line, index)}
      </Text>;
    })}
  </Text>;

  // Puck and dots in bar space: the free zone first, then the line.
  const free = lit != null ? puck.free : freeZoneFraction(0, width.current || 360);
  // Between passes the puck waits at the start, ready for the next try.
  const position = lit != null ? puck.position : 0;
  const lineAt = (fraction: number) => free + (1 - free) * fraction;
  // Spoken by screen readers only; the pad itself is self-explanatory.
  const hint = method === 'swipe'
    ? 'Hold the bar and slide right as the words are sung. The shaded start syncs nothing; slide back to redo words; let go early to retry.'
    : done ? 'Already synced. Start or Commit syncs it again from the first word.'
      : open >= 0 ? `Singing “${line.words[open].text.trim()}”: Commit when the next one starts, End if there is a pause.`
        : next < 0 ? 'End when the line ends.' : `Start when “${line.words[next].text.trim()}” starts.`;

  return <View style={styles.pad}>
    {line.background ? <Text style={styles.badge}>AD-LIB</Text> : null}
    {method === 'swipe' ? <>
      <View style={styles.surface} accessible accessibilityLabel={hint}>{text}</View>
      <GestureDetector gesture={slide}>
        <View collapsable={false} style={styles.bar} onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
          accessibilityRole="adjustable" accessibilityLabel="Slide to sync this line">
          <View pointerEvents="none" style={[styles.freeZone, { width: `${free * 100}%` }]} />
          {plan.starts.map((start, index) => {
            const at = lineAt((start + plan.counts[index]) / Math.max(1, plan.total));
            return <View key={index} pointerEvents="none" style={[styles.dot, { left: `${at * 100}%` }, at <= position + 1e-6 && styles.dotLit]} />;
          })}
          <View pointerEvents="none" style={[styles.thumb, { left: `${position * 100}%`, marginLeft: -position * THUMB }]} />
        </View>
      </GestureDetector>
    </> : <>
      <View style={styles.surface} accessible accessibilityLabel={hint}>{text}</View>
      <View style={styles.keys}>
        {KEYS.map(({ key, label, hint: keyHint }) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`${label}: ${keyHint}`}
          onPressIn={key === 'F' ? onStart : key === 'G' ? onCommit : onEnd}
          style={({ pressed }) => [styles.key, pressed && styles.surfacePressed]}>
          <Text style={styles.keyLetter}>{key}</Text>
          <Text style={styles.keyLabel}>{label}</Text>
        </Pressable>)}
      </View>
    </>}
  </View>;
});

const styles = StyleSheet.create({
  pad: { gap: 8 },
  badge: { alignSelf: 'flex-start', color: Design.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: 'rgba(168,240,207,0.12)' },
  surface: { minHeight: 64, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: Design.border },
  keys: { flexDirection: 'row', gap: 8 },
  key: { flex: 1, height: 66, borderRadius: 16, alignItems: 'center', justifyContent: 'center', paddingBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: Design.border },
  keyLetter: { flex: 1, textAlignVertical: 'center', paddingTop: 6, color: 'rgba(245,247,252,0.22)', fontSize: 22, fontWeight: '800' },
  keyLabel: { color: Design.text, fontSize: 13, fontWeight: '700' },
  surfacePressed: { backgroundColor: 'rgba(168,240,207,0.14)', borderColor: Design.accent },
  line: { color: 'rgba(245,247,252,0.55)', fontWeight: '800' },
  adLib: { fontWeight: '600', fontStyle: 'italic' },
  lit: { color: Design.accent, backgroundColor: 'rgba(168,240,207,0.16)' },
  next: { color: Design.text, textDecorationLine: 'underline' },
  syncing: { color: '#8EC5FF', backgroundColor: 'rgba(110,170,255,0.2)' },
  picked: { color: '#FFD98A', backgroundColor: 'rgba(255,214,102,0.18)' },
  pickedLine: { textDecorationLine: 'underline', textDecorationColor: '#FFD98A' },
  bar: { height: 52, borderRadius: 16, backgroundColor: '#000', justifyContent: 'center', paddingHorizontal: 0, overflow: 'hidden' },
  freeZone: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.07)' },
  dot: { position: 'absolute', top: 24, width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)' },
  dotLit: { backgroundColor: Design.accent },
  thumb: { position: 'absolute', top: 14, width: THUMB, height: 24, borderRadius: 12, backgroundColor: Design.accent },
});
