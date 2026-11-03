import { useEffect, useMemo } from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { receiveArrivalUiSample, registerArrivalUiReader, requestArrivalUiSample, type ArrivalHandle, type ArrivalUiTotals } from './lyrics-arrival-trace';
export type PictureMeasurement = { handle: ArrivalHandle; generation: number; epoch: number;
  counts: SharedValue<ArrivalUiTotals & { reported: boolean; active: boolean }> };
let epoch = 0;
function sampleUi(measurement: PictureMeasurement, request: number) {
  'worklet';
  const { pictureBuilds, paintConstructors, blurFilterConstructors, shaderConstructors } = measurement.counts.value;
  scheduleOnRN(receiveArrivalUiSample, measurement.handle, measurement.epoch, measurement.generation,
    { pictureBuilds, paintConstructors, blurFilterConstructors, shaderConstructors }, request, performance.now());
}
function stopUiMeasurement(measurement: PictureMeasurement) {
  'worklet';
  measurement.counts.modify(value => { value.active = false; return value; });
}
function useDevPictureMeasurement(handle: ArrivalHandle | undefined, generation: number, words: object, width: number, height: number) {
  // A fresh measurement cell per epoch. Cleanup keeps the old cell for its final
  // sample, even if a recycled cell starts drawing under a new owner first.
  const measurement = useMemo<PictureMeasurement | undefined>(() => handle ? {
    handle, generation, epoch: ++epoch, counts: makeMutable<ArrivalUiTotals & { reported: boolean; active: boolean }>({ pictureBuilds: 0, paintConstructors: 0, blurFilterConstructors: 0, shaderConstructors: 0, reported: false, active: true }),
  } : undefined, [handle, generation, words, width, height]);
  useEffect(() => {
    if (!measurement) return;
    const read = () => requestArrivalUiSample(request => scheduleOnUI(sampleUi, measurement, request));
    const stop = () => scheduleOnUI(stopUiMeasurement, measurement);
    const unregister = registerArrivalUiReader(measurement.handle, measurement.epoch, read, stop);
    return () => { void read(); unregister(); };
  }, [measurement]);
  return measurement;
}
// Selected once per build. Production allocates no hook, shared value or reader.
export const useArrivalPictureMeasurement = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevPictureMeasurement : () => undefined;
