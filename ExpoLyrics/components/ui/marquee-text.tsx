import { memo } from "react";
import { Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

type MarqueeTextProps = {
  children: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
};

export const MarqueeText = memo(function MarqueeText({
  children,
  style,
}: MarqueeTextProps) {
  return <Text style={style} numberOfLines={1} ellipsizeMode="tail">{children}</Text>;
});
