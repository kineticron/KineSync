import { Image as ExpoImage, type ImageProps } from "expo-image";
import { memo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

const ARTWORK_CROSSFADE_MS = 380;

type BridgedArtworkImageProps = Omit<ImageProps, "source" | "transition"> & {
  uri: string;
  recyclingKey?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** Set to 0 to skip crossfade (e.g. during UI-thread morph animations). */
  transitionMs?: number;
};

export const BridgedArtworkImage = memo(function BridgedArtworkImage({
  uri,
  recyclingKey,
  containerStyle,
  style,
  transitionMs = ARTWORK_CROSSFADE_MS,
  ...rest
}: BridgedArtworkImageProps) {
  const safeUri = String(uri || "").trim();
  if (!safeUri) {
    return null;
  }

  return (
    <View style={[style, containerStyle]} pointerEvents="none">
      <ExpoImage
        {...rest}
        source={{ uri: safeUri }}
        style={StyleSheet.absoluteFillObject}
        cachePolicy="memory-disk"
        recyclingKey={recyclingKey ?? safeUri}
        transition={transitionMs > 0 ? transitionMs : undefined}
      />
    </View>
  );
});
