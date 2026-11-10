import { Switch, Text, View } from 'react-native';
import { setTightBlurBounds, useTightBlurBounds } from '@/lib/tight-blur-bounds';

export function TightBlurBoundsSwitch() {
  const enabled = useTightBlurBounds();
  if (!__DEV__) return null;
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Tight blur bounds</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental native glow layer bounds</Text>
    </View>
    <Switch accessibilityLabel="Tight blur bounds" value={enabled} onValueChange={setTightBlurBounds} />
  </View>;
}
