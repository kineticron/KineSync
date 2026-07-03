import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { useColorScheme } from 'react-native';

export default function ModalScreen() {
  const theme = useColorScheme() ?? 'light';
  return (
    <View style={[{ backgroundColor: Colors[theme].background }, styles.container]}>
      <Text style={[{ color: Colors[theme].text, fontSize: 32, fontWeight: 'bold', lineHeight: 32 }, styles.title]}>
        This is a modal
      </Text>
      <Link href="/" dismissTo style={styles.link}>
        <Text style={[{ color: '#0a7ea4', lineHeight: 30, fontSize: 16 }]}>
          Go to home screen
        </Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    marginBottom: 10,
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
});
