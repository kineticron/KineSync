import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

declare class VideoEncoderModule extends NativeModule {
  start(path: string, width: number, height: number, fps: number, bitRate: number): void;
  addFrame(pixels: Uint8Array): void;
  finish(): string;
  cancel(): void;
}

/** modules/kinesync-video-encoder: MediaCodec on Android, AVAssetWriter on iOS. */
const native = Platform.OS === 'android' || Platform.OS === 'ios' ? requireOptionalNativeModule<VideoEncoderModule>('KineSyncVideoEncoder') : null;
/** Byte order the encoder takes frames in (Skia reads either directly). */
export const videoFrameOrder = Platform.OS === 'ios' ? 'bgra' : 'rgba';

export const canMakeVideo = () => native != null;

export function startVideo(path: string, width: number, height: number, fps: number, bitRate: number) {
  if (!native) throw new Error('Video sharing is not available on this device yet.');
  native.start(path, width, height, fps, bitRate);
}
export const addVideoFrame = (pixels: Uint8Array) => native?.addFrame(pixels);
export const finishVideo = () => native?.finish() ?? '';
export const cancelVideo = () => native?.cancel();
