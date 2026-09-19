import type { ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { amlPositionSpring } from "@/lib/amll-native";

export type NativeLyricScroll = { from: number; target: number; revision: number; firstVisible: number; focus: number;
  spring: ReturnType<typeof amlPositionSpring> };

/** The list owns scrolling as one unified motion, matching main's AMLL
 * WebView: rows never stagger/shift relative to each other while the list
 * glides on a single position spring. This wrapper is kept as a passthrough
 * so callers don't churn; per-row Y compensation is intentionally disabled. */
export function NativeLyricMotion({ children }: {
  children: ReactNode; index: number; command: SharedValue<NativeLyricScroll>;
  offset: SharedValue<number>; enabled: SharedValue<boolean>; active: boolean;
}) {
  return <>{children}</>;
}
