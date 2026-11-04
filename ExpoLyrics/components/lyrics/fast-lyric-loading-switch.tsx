import { Switch, Text, View } from 'react-native';
import { setFastLyricLoading, useFastLyricLoading } from '@/lib/fast-lyric-loading';

export function FastLyricLoadingSwitch() {
  const enabled = useFastLyricLoading();
  if (!__DEV__) return null;
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Fast lyric loading</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental native paragraph fidelity comparison</Text>
    </View>
    <Switch accessibilityLabel="Fast lyric loading" value={enabled} onValueChange={setFastLyricLoading} />
  </View>;
}
