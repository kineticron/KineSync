import { Platform, Switch, Text, View } from 'react-native';
import { setRetainedActiveLine, useRetainedActiveLine } from '@/lib/retained-active-line';

export function RetainedActiveLineSwitch() {
  const enabled = useRetainedActiveLine();
  if (!__DEV__ || Platform.OS === 'web') return null;
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Retained active-line renderer</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental AA mask · Spicy and AMLL · visual differences possible</Text>
    </View>
    <Switch accessibilityLabel="Retained active-line renderer" value={enabled} onValueChange={setRetainedActiveLine} />
  </View>;
}
