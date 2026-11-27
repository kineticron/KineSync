import { BlurView } from 'expo-blur';
import { type ReactNode } from 'react';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Pressable is a pointer-only backdrop with no visual feedback and no nested content
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NativeTouchable } from '@/components/ui/native-touchable';

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
    <GestureHandlerRootView style={dialogStyles.root}>
      {/* Android does not hide modal siblings from accessibility, so the
          backdrop remains a labeled close button there. iOS hides it behind
          accessibilityViewIsModal and keeps Done and the escape action. */}
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={[StyleSheet.absoluteFill, dialogStyles.backdrop, {
          paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom),
          paddingLeft: Math.max(24, insets.left), paddingRight: Math.max(24, insets.right),
        }]}
        onPress={onClose}
      />
      <View pointerEvents="box-none" style={[dialogStyles.scrim, {
        paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom),
        paddingLeft: Math.max(24, insets.left), paddingRight: Math.max(24, insets.right),
      }]}>
        <Animated.View entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)} style={dialogStyles.dialog}>
          <View style={dialogStyles.dialogBody} accessibilityViewIsModal onAccessibilityEscape={onClose}>
            <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} />
            <ScrollView style={dialogStyles.detailsScroll} contentContainerStyle={dialogStyles.details}>{children}</ScrollView>
          </View>
        </Animated.View>
      </View>
    </GestureHandlerRootView>
  </Modal>;
}

export function LyricsDialogTitle({ children }: { children: ReactNode }) {
  return <Text accessibilityRole="header" style={dialogStyles.title}>{children}</Text>;
}

export function LyricsDialogAction({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <NativeTouchable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[dialogStyles.close, disabled && dialogStyles.disabled]}>
    <Text style={dialogStyles.closeText}>{label}</Text>
  </NativeTouchable>;
}

export const dialogStyles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.25)' },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
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
