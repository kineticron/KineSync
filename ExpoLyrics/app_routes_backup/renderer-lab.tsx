import React from 'react';
import { Redirect } from 'expo-router';

export default function RendererLabRoute() {
  if (!__DEV__ && process.env.EXPO_PUBLIC_LYRICS_LAB !== '1') return <Redirect href="/" />;
  // Lazy execution keeps experimental native engines out of normal startup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RendererLab } = require('@/components/lyrics/native/renderer-lab') as typeof import('@/components/lyrics/native/renderer-lab');
  return <RendererLab />;
}
