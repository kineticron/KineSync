import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { cancelAnimation, runOnJS, useEvent, type SharedValue } from "react-native-reanimated";

/** Stop auto-follow on the UI thread before JS handles the drag bookkeeping. */
export function useLyricScrollInterruption(
  offset: SharedValue<number>,
  active: SharedValue<boolean>,
  onBeginDrag: (offset: number) => void,
  staggerEnabled?: SharedValue<boolean>,
) {
  return useEvent<NativeSyntheticEvent<NativeScrollEvent>>((event) => {
    "worklet";
    cancelAnimation(offset);
    active.value = false;
    if (staggerEnabled) staggerEnabled.value = false;
    runOnJS(onBeginDrag)(Math.max(0, event.contentOffset.y));
  }, ["onScrollBeginDrag"], true);
}
