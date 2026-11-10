import { Platform, Switch, Text, View } from 'react-native';
import { setSimpleAmllScroll, useSimpleAmllScroll } from '@/lib/simple-amll-scroll';
import { usePlaybackStore } from '@/store/playback-store';

export function SimpleAmllScrollSwitch() {
  const enabled = useSimpleAmllScroll();
  const lyricsStyle = usePlaybackStore(s => s.lyricsStyle);
  if (!__DEV__ || Platform.OS === 'web' || lyricsStyle !== 'amll') return null;
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ color: '#F8F8FE', fontSize: 14, fontWeight: '600' }}>Simple AMLL scroll</Text>
        <Text style={{ color: 'rgba(248,248,254,0.58)', fontSize: 11 }}>Experimental shared analytic critically damped scroll · AMLL only</Text>
      </View>
      <Switch accessibilityLabel="Simple AMLL scroll" value={enabled} onValueChange={setSimpleAmllScroll} />
    </View>
  );
}
