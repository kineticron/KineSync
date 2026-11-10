import React from 'react';
import { useRelaxedRendering } from '@/lib/relaxed-rendering';
import { NativeGlyphPicture } from './native-glyph-picture';
import { RelaxedGlyphPicture } from './relaxed-glyph-graph';
export function RelaxedGlyphSwitch(props: React.ComponentProps<typeof NativeGlyphPicture>) {
  const flags = useRelaxedRendering();
  return __DEV__ && flags.glyphPicture ? <RelaxedGlyphPicture {...props} /> : <NativeGlyphPicture {...props} />;
}
