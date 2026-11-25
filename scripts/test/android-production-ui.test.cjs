const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const directory = 'scripts/android-production-ui';
const actions = JSON.parse(read(`${directory}/production-ui-robo.json`));
const explore = read('ExpoLyrics/app/(tabs)/explore.tsx');
const menu = read('ExpoLyrics/components/lyrics/settings-menu.tsx');
const topBar = read('ExpoLyrics/components/lyrics/top-bar.tsx');
const button = 'android.widget.Button';
const radio = 'android.widget.RadioButton';
const scrollView = 'android.widget.ScrollView';
const scrollIntoView = 'ELEMENT_SCROLL_INTO_VIEW';

function matches(descriptor, { className, text, description }) {
  return (!descriptor.className || descriptor.className === className)
    && (!descriptor.text || descriptor.text === text)
    && (!descriptor.contentDescription || descriptor.contentDescription === description)
    && (!descriptor.contentDescriptionRegex || (
      description !== undefined && new RegExp(descriptor.contentDescriptionRegex).test(description)
    ));
}

function click(target, optional = false) {
  const indices = actions.flatMap((action, index) =>
    action.eventType === 'VIEW_CLICKED' && matches(action.elementDescriptors[0], target) ? [index] : []);
  assert.ok(indices.length, `Missing click for ${target.description ?? target.text}`);
  for (const index of indices) {
    assert.equal(actions[index].optional ?? false, optional);
  }
  return indices[0];
}

test('Robo targets the source labels and the renderer radio parents', () => {
  const openMenu = topBar.match(/accessibilityRole="button"\s+accessibilityLabel="(Open player menu)"/)[1];
  const open = click({ className: button, description: openMenu });
  assert.ok(menu.includes('accessibilityLabel={`${title} lyrics renderer${active ? ", selected" : ""}`}'));
  const styleSelectors = [...menu.matchAll(/title: "(AMLL|Spicy Lyrics)"/g)].map(([, style]) => {
    const plain = click({ className: radio, description: `${style} lyrics renderer` });
    assert.equal(click({ className: radio, description: `${style} lyrics renderer, selected` }), plain);
    return plain;
  }).sort((left, right) => left - right);
  assert.equal(styleSelectors.length, 2);

  const settingsLabel = menu.match(/<MenuAction icon="settings-outline" label="([^"]+)" onPress={onOpenBridgeSettings}/)[1];
  const settings = click({ className: button, description: `\uf493, ${settingsLabel}, \uf285` });
  assert.ok(menu.includes('<Text style={styles.headerTitle}>Settings</Text>'));
  assert.equal(matches(actions[settings].elementDescriptors[0], {
    className: 'android.widget.TextView', text: settingsLabel,
  }), false);

  const advancedLabel = explore.match(/<SettingSection title="(Advanced)" collapsible>/)[1];
  assert.match(explore, /accessibilityRole="button" accessibilityLabel={title}/);
  const advanced = click({ className: button, description: advancedLabel });
  assert.deepEqual(actions[advanced].elementDescriptors, [{ className: button, contentDescription: advancedLabel }]);
  assert.equal(matches(actions[advanced].elementDescriptors[0], {
    className: button, description: 'Advanced lyrics settings',
  }), false);

  const backendOptions = explore.slice(explore.indexOf('<SettingSection title="Advanced"'), explore.indexOf('{lyricsRendererBackendSaveFailed'));
  assert.match(backendOptions, /\(\['rust', 'skia'\] as const\)\.map\(backend/);
  const [, rust, skia] = backendOptions.match(/const label = backend === 'rust' \? '([^']+)' : '([^']+)'/);
  assert.ok(backendOptions.includes('accessibilityRole="radio"'));
  assert.ok(backendOptions.includes('onPress={() => setLyricsRendererBackend(backend)}'));
  assert.ok(backendOptions.includes('<Text style={styles.secondaryButtonText}>{label}</Text>'));
  const skiaClick = click({ className: radio, description: `\uf500, ${skia}` });
  const rustClick = click({ className: radio, description: `\uf4ff, ${rust}` });
  for (const [index, label] of [[skiaClick, skia], [rustClick, rust]]) {
    const descriptor = actions[index].elementDescriptors[0];
    assert.equal(click({ className: radio, description: label }), index);
    assert.equal(matches(descriptor, { className: 'android.widget.TextView', text: label }), false);
    assert.equal(matches(descriptor, { className: radio, description: `${label} diagnostics` }), false);
  }
  const [amll, spicy] = styleSelectors;
  const back = actions.findIndex(action => action.eventType === 'PRESSED_BACK');
  assert.ok(open < amll && amll < spicy && spicy < settings && settings < advanced
    && advanced < rustClick && rustClick < skiaClick && skiaClick < back);

  const scrollActions = actions.flatMap((action, index) => action.eventType === scrollIntoView ? [index] : []);
  assert.deepEqual(scrollActions, [settings, advanced, rustClick, skiaClick].map(index => index - 1));
  for (const index of scrollActions) {
    assert.deepEqual(actions[index].elementDescriptors, [{ className: scrollView }]);
    assert.deepEqual(actions[index].childElementDescriptors, actions[index + 1].elementDescriptors);
  }

  const closeMenu = menu.match(/accessibilityLabel="(Close player menu)"/)[1];
  const close = click({ className: button, description: closeMenu });
  assert.ok(actions.slice(back + 1, close).some(action => action.eventType === 'VIEW_CLICKED'
    && matches(action.elementDescriptors[0], { className: button, description: openMenu })));
});

test('Robo keeps automation in one session and requires all non-setup targets', () => {
  const onboarding = read('ExpoLyrics/components/onboarding/onboarding-screen.tsx');
  const tour = read('ExpoLyrics/components/onboarding/player-tour-overlay.tsx');
  assert.match(onboarding, />Skip<\/Text>/);
  const tourSkip = tour.match(/accessibilityLabel="(Skip player tour)"/)[1];
  const skip = click({ text: 'Skip' }, true);
  const skipTour = click({ className: button, description: tourSkip }, true);
  assert.deepEqual(actions.flatMap((action, index) => action.optional ? [index] : []), [skip, skipTour]);

  const eventTypes = new Set(['VIEW_CLICKED', scrollIntoView, 'WAIT', 'TAKE_SCREENSHOT', 'PRESSED_BACK']);
  for (const action of actions) {
    assert.ok(eventTypes.has(action.eventType), 'single-session phase allows no shell commands or app restarts');
    assert.equal(action.command, undefined, 'Robo must own accessibility and remain attached to the app');
    if (action.eventType === 'VIEW_CLICKED') {
      assert.equal(action.elementDescriptors.length, 1);
    }
    if (action.eventType === 'TAKE_SCREENSHOT') {
      assert.doesNotMatch(action.screenshotName, /restart|persist|cold|assert|checked/i);
    }
  }

  const guide = read(`${directory}/README.md`);
  assert.match(guide, /Cold relaunch, backend persistence, rotation, and background resume are unverified by this Robo phase/);
  assert.match(guide, /assert the native checked state before any selection action/);
});
