import { Redirect } from 'expo-router';

export default function ArrivalLabRoute() {
  if (__DEV__) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ArrivalLab } = require('@/components/lyrics/native/arrival-lab') as typeof import('@/components/lyrics/native/arrival-lab');
    return <ArrivalLab />;
  }
  return <Redirect href="/" />;
}
