import { Switch, Text, View } from 'react-native';
import { setMotionBuffers, useMotionBuffers } from '@/lib/motion-buffers-setting';

export function MotionBuffersSwitch() {
  const enabled = useMotionBuffers();
  if (!__DEV__) return null;
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Reuse motion buffers</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental · original renderer · resets OFF each session</Text>
    </View>
    <Switch accessibilityLabel="Reuse motion buffers" value={enabled} onValueChange={setMotionBuffers} />
  </View>;
}
