export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (new URL(path).hostname === 'expo-sharing') return '/vault';
    return path;
  } catch {
    return path;
  }
}
