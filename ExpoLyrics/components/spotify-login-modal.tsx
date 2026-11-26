import Ionicons from '@react-native-vector-icons/ionicons';
import type { ComponentProps } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable } from '@/components/ui/motion-pressable';
import { SpotifyLoginWebView } from './spotify-login-webview';

type SpotifyLoginModalProps = Pick<ComponentProps<typeof SpotifyLoginWebView>, 'onMessage'> & {
  visible: boolean;
  onClose: () => void;
};

export function SpotifyLoginModal({ visible, onClose, onMessage }: SpotifyLoginModalProps) {
  return (
    <Modal
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.content} edges={['top', 'right', 'bottom', 'left']}>
            <View style={styles.header}>
              <Text style={styles.title}>Sign in with Spotify</Text>
              <MotionPressable
                accessibilityRole="button"
                accessibilityLabel="Close Spotify sign in"
                onPress={onClose}
                style={styles.closeButton}
              >
                <Ionicons name="close" size={21} color="#FFFFFF" />
              </MotionPressable>
            </View>
            <SpotifyLoginWebView onMessage={onMessage} />
          </SafeAreaView>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#090A11',
  },
  content: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 18,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#11131C',
  },
  title: {
    flexShrink: 1,
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
