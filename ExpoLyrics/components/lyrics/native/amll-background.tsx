import React, { memo, type ReactNode } from 'react';
import { View } from 'react-native';

/** Background vocals always participate in normal flow, including recycled rows. */
export const AmllBackground = memo(function AmllBackground({ children, fontSize }: {
  children: ReactNode; fontSize: number;
}) {
  return <View style={{ marginTop: fontSize * 0.3, opacity: 0.4 }}>{children}</View>;
});
