import { Switch, Text, View } from 'react-native';
import { setBatchedAmllMotion, useBatchedAmllMotion } from '@/lib/batched-amll-motion';

export function BatchedAmllMotionSwitch() {
  const enabled = useBatchedAmllMotion();
  if (!__DEV__) return null;
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Batched AMLL motion</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental native scroll batching</Text>
    </View>
    <Switch accessibilityLabel="Batched AMLL motion" value={enabled} onValueChange={setBatchedAmllMotion} />
  </View>;
}
