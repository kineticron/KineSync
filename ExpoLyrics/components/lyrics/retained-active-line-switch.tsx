import { Platform, Pressable, Switch, Text, View } from 'react-native';
import { setRetainedActiveLine, useRetainedActiveLine, setRetainedClipVariant, useRetainedClipVariant } from '@/lib/retained-active-line';

export function RetainedActiveLineSwitch() {
  const enabled = useRetainedActiveLine();
  const variant = useRetainedClipVariant();
  if (!__DEV__ || Platform.OS === 'web') return null;
  return <View><View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Retained active-line renderer</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental · Spicy and AMLL · visual differences possible</Text>
    </View>
    <Switch accessibilityLabel="Retained active-line renderer" value={enabled} onValueChange={setRetainedActiveLine} />
  </View>
    {enabled && <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11, marginBottom: 6 }}>Clip variant · session only</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['mask', 'group'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: variant === value }}
          accessibilityLabel={value === 'mask' ? 'AA mask' : 'No mask: aliased native Group clip'} onPress={() => setRetainedClipVariant(value)}
          style={{ padding: 8, borderRadius: 8, backgroundColor: variant === value ? 'rgba(248,248,254,0.18)' : 'rgba(248,248,254,0.06)' }}>
          <Text style={{ color: '#F8F8FE', fontSize: 12 }}>{value === 'mask' ? 'AA mask' : 'No mask · aliased clip'}</Text>
        </Pressable>)}
      </View>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11, marginTop: 6 }}>{variant === 'group'
        ? 'Phone-test variant: sharper or jagged reveal edges. Native AA Group clips require a new binary; unavailable here.'
        : 'Current mask composition. Extra offscreen layers may reduce UI performance.'}</Text>
    </View>}
  </View>;
}
