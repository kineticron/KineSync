import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

export default function LabLayout() {
  return <GestureHandlerRootView style={styles.root}><Stack screenOptions={{ headerShown: false }} /></GestureHandlerRootView>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
