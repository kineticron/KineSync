import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { isDealerDeliveryExperimentEnabled, setDealerDeliveryExperimentEnabled } from '../../lib/spotify-detector/dealer-delivery-experiment-toggle';

/** Temporary native-only A/B control. The default is ON for a development JS runtime. */
export function DealerDeliveryExperimentSwitch() {
  const [enabled, setEnabled] = useState(isDealerDeliveryExperimentEnabled);
  if (typeof __DEV__ === 'undefined' || !__DEV__) return null;
  const toggle = (next: boolean) => setEnabled(setDealerDeliveryExperimentEnabled(next));
  return <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Spotify delivery experiment</Text>
      <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Dealer-only lower-envelope comparison</Text>
    </View>
    <Switch accessibilityRole="switch" accessibilityLabel="Spotify delivery experiment"
      accessibilityState={{ checked: enabled }} testID="spotify-delivery-experiment-switch"
      value={enabled} onValueChange={toggle} />
  </View>;
}
