const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(appRoot, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

const touchable = read('components/ui/native-touchable.tsx');
const motion = read('components/ui/motion-pressable.tsx');

test('gesture handler is pinned to a version that supports RN 0.88', () => {
  const range = pkg.dependencies['react-native-gesture-handler'];
  assert.match(range, /^~3\.4\./);
  assert.equal(
    pkg.expo?.install?.exclude?.includes('react-native-gesture-handler'),
    true,
  );
  assert.equal(
    lock.packages['node_modules/react-native-gesture-handler'].version,
    '3.4.0',
  );
});

test('shared press targets use the native delayed press path', () => {
  for (const source of [touchable, motion]) {
    assert.match(source, /from ["']react-native-gesture-handler["']/);
    assert.match(source, /immediatePressOut={false}/);
    assert.match(source, /delayLongPress = 500/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
  }
  assert.match(touchable, /accessible = true/);
  assert.match(motion, /accessible = true/);
  assert.match(motion, /Animated\.createAnimatedComponent\(Touchable\)/);
});

test('scroll ownership moved to gesture handler scrollers', () => {
  for (const file of [
    'app/(tabs)/explore.tsx',
    'components/lyrics/settings-menu.tsx',
    'components/lyrics/translation-language-picker.tsx',
    'components/lyrics/lyrics-glass-dialog.tsx',
    'components/lyrics/listening-empty-state.tsx',
  ]) {
    const source = read(file);
    assert.match(source, /from ["']react-native-gesture-handler["']/);
    assert.match(source, /\bScrollView\b/);
  }

  const onboarding = read('components/onboarding/onboarding-screen.tsx');
  assert.match(onboarding, /ScrollView as GestureScrollView/);
  assert.match(onboarding, /createAnimatedComponent\(GestureScrollView\)/);

  const vault = read('app/(tabs)/vault.tsx');
  assert.match(vault, /renderScrollComponent={ScrollView}/);
});

test('modals that host native press targets declare their own root', () => {
  const scanner = read('app/(tabs)/explore.tsx');
  assert.match(scanner, /<Modal[\s\S]*<GestureHandlerRootView/);
  assert.match(scanner, /<GestureHandlerRootView style={styles\.scannerModal}>/);

  assert.match(
    read('components/lyrics/lyrics-glass-dialog.tsx'),
    /<Modal[\s\S]*<GestureHandlerRootView/,
  );
  assert.match(
    read('components/lyrics/translation-language-picker.tsx'),
    /<Modal[\s\S]*<GestureHandlerRootView/,
  );

  const settings = read('components/lyrics/settings-menu.tsx');
  assert.ok((settings.match(/<GestureHandlerRootView/g) || []).length >= 2);
});

test('press feedback surfaces stay migrated without moving scrims or blockers', () => {
  const index = read('app/(tabs)/index.tsx');
  assert.equal((index.match(/<Pressable/g) || []).length, 2);
  assert.equal((index.match(/<NativeTouchable/g) || []).length, 4);

  const playback = read('components/lyrics/playback-controls.tsx');
  assert.equal((playback.match(/<NativeTouchable/g) || []).length, 6);
  assert.equal((playback.match(/<Pressable/g) || []).length, 0);

  const dialog = read('components/lyrics/lyrics-glass-dialog.tsx');
  assert.equal((dialog.match(/<Pressable/g) || []).length, 1, 'Only the backdrop is a Pressable');
  assert.equal((dialog.match(/<\/Pressable>/g) || []).length, 0, 'The backdrop does not wrap the dialog');
  assert.match(dialog, /accessibilityRole="button"/, 'Backdrop stays a labeled close action');
  assert.match(dialog, /StyleSheet\.absoluteFill/, 'Backdrop uses the supported absolute fill style');
  assert.match(dialog, /<Pressable[\s\S]*?\/>\s*<View pointerEvents="box-none"/);
  assert.match(dialog, /<View style={dialogStyles\.dialogBody} accessibilityViewIsModal/);
  assert.match(dialog, /<NativeTouchable accessibilityRole="button"/);
});

test('the regression check is part of the default test command', () => {
  assert.match(pkg.scripts.test, /test:touch-feedback/);
  assert.match(
    pkg.scripts['test:touch-feedback'],
    /test-native-touch-feedback\.cjs/,
  );
});
