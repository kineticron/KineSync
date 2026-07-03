import {
  withSpring,
  type SharedValue,
} from "react-native-reanimated";

export const ICON_BUTTON_PRESS_SCALE = 1.16;

const PRESS_SPRING = {
  damping: 15,
  stiffness: 210,
  mass: 0.82,
};

const RELEASE_SPRING = {
  damping: 17,
  stiffness: 165,
  mass: 0.9,
};

export function animateIconButtonPressIn(scale: SharedValue<number>) {
  scale.value = withSpring(ICON_BUTTON_PRESS_SCALE, PRESS_SPRING);
}

export function animateIconButtonPressOut(scale: SharedValue<number>) {
  scale.value = withSpring(1, RELEASE_SPRING);
}
