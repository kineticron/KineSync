import { BlurView } from 'expo-blur';
import { type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = {
  visible: boolean;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
};

// Shared shell for the lyrics attribution and protected-export dialogs.
export function LyricsGlassDialog({ visible, onClose, closeLabel, children }: Props) {
  const insets = useSafeAreaInsets();
  return <Modal transparent visible={visible} animationType="fade" statusBarTranslucent
    supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
    onRequestClose={onClose}>
    <Pressable accessibilityLabel={closeLabel} style={[dialogStyles.scrim, {
      paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom),
      paddingLeft: Math.max(24, insets.left), paddingRight: Math.max(24, insets.right),
    }]} onPress={onClose}>
      <Animated.View entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)} style={dialogStyles.dialog}>
        <Pressable style={dialogStyles.dialogBody} onPress={event => event.stopPropagation()} accessibilityViewIsModal onAccessibilityEscape={onClose}>
          <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} />
          <ScrollView style={dialogStyles.detailsScroll} contentContainerStyle={dialogStyles.details}>{children}</ScrollView>
        </Pressable>
      </Animated.View>
    </Pressable>
  </Modal>;
}

export function LyricsDialogTitle({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={dialogStyles.title}>{children}</Text>;
}

export function LyricsDialogAction({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[dialogStyles.close, disabled && dialogStyles.disabled]}>
    <Text style={dialogStyles.closeText}>{label}</Text>
  </Pressable>;
}

export const dialogStyles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.25)' },
  dialog: { width: '100%', maxWidth: 380, maxHeight: '80%', borderRadius: 24, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(24,24,30,0.18)' },
  dialogBody: { flexShrink: 1 },
  detailsScroll: { flexShrink: 1 },
  details: { padding: 24, gap: 12, alignItems: 'stretch' },
  title: { color: '#FFF', fontSize: 21, fontWeight: '600' },
  detailProvider: { color: '#FFF', fontSize: 15, fontWeight: '500' },
  description: { color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 20 },
  close: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  closeText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
