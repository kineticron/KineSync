const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const directory = 'scripts/android-production-ui';
const script = read(`${directory}/production-ui-robo.json`);
const headerEnd = script.indexOf('\n');
const headerPrefix = '"roboscript": ';
assert.ok(headerEnd > 0 && script.startsWith(headerPrefix), 'Firebase execution header must precede the action array');
const execution = JSON.parse(script.slice(headerPrefix.length, headerEnd));
const actions = JSON.parse(script.slice(headerEnd + 1));
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

test('Robo targets the player style radios and checks Advanced without editing API settings', () => {
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

  const mobileLabel = explore.match(/accessibilityRole="radio"\s+accessibilityLabel="([^"]+)"\s+aria-checked=\{playbackMode === 'mobile'\}\s+accessibilityState=\{\{ checked: playbackMode === 'mobile' \}\}/)[1];
  const mobile = click({ className: radio, description: mobileLabel });
  const [, advancedLabel, advancedBody] = explore.match(/playbackMode === 'mobile' \? <SettingSection title="(Advanced)" collapsible>([\s\S]*?)<\/SettingSection>/);
  assert.match(explore, /accessibilityRole="button" accessibilityLabel={title}/);
  const advanced = click({ className: button, description: advancedLabel });
  assert.deepEqual(actions[advanced].elementDescriptors, [{ className: button, contentDescription: advancedLabel }]);
  assert.doesNotMatch(advancedBody, /accessibilityRole="radio"/);
  assert.equal((explore.match(/<SettingSection title="Advanced"/g) ?? []).length, 1);
  assert.match(explore, /secureTextEntry=\{secureTextEntry\}/);
  assert.deepEqual(
    [...advancedBody.matchAll(/<FieldRow\s+label="([^"]+)"[^>]*\bsecureTextEntry\s*\/>/g)].map(([, label]) => label),
    ['Spotify Bearer Token', 'Musixmatch User API Token (Manual Override)', 'Gemini API Key'],
  );
  const saveLabel = advancedBody.match(/accessibilityRole="button"\s+accessibilityLabel="([^"]+)"\s+onPress=\{saveMobileLyricsApiSettings\}/)[1];
  const saveTarget = [{ className: button, contentDescription: saveLabel }];
  const saveScroll = actions.findIndex(action => action.eventType === scrollIntoView
    && matches(action.childElementDescriptors[0], { className: button, description: saveLabel }));
  const mobileAssertion = mobile + 2;
  const saveAssertion = saveScroll + 2;
  const [amll, spicy] = styleSelectors;
  const back = actions.findIndex(action => action.eventType === 'PRESSED_BACK');
  assert.ok(open < amll && amll < spicy && spicy < settings && settings < mobile
    && mobileAssertion < advanced && advanced < saveScroll && saveAssertion + 1 < back);
  assert.equal(actions[mobile + 1].eventType, 'WAIT');
  assert.deepEqual(actions[mobileAssertion], {
    eventType: 'ASSERTION',
    contextDescriptor: { condition: 'element_checked', elementDescriptors: [{ className: radio, contentDescription: mobileLabel }] },
  });
  assert.equal(actions[saveScroll + 1].eventType, 'WAIT');
  assert.deepEqual(actions[saveAssertion], {
    eventType: 'ASSERTION',
    contextDescriptor: { condition: 'element_present', elementDescriptors: saveTarget },
  });
  const settingsScreenshots = actions.flatMap((action, index) =>
    settings < index && index < back && action.eventType === 'TAKE_SCREENSHOT' ? [index] : []);
  assert.deepEqual(settingsScreenshots, [saveAssertion + 1], 'the only Settings screenshot follows the mobile Advanced assertion');
  const settingsClicks = actions.flatMap((action, index) =>
    settings < index && index < back && action.eventType === 'VIEW_CLICKED' ? [index] : []);
  assert.deepEqual(settingsClicks, [mobile, advanced]);

  const scrollActions = actions.flatMap((action, index) => action.eventType === scrollIntoView ? [index] : []);
  const scrollAndClick = [settings, mobile, advanced].map(index => index - 1);
  assert.deepEqual(scrollActions, [...scrollAndClick, saveScroll]);
  for (const index of scrollActions) assert.deepEqual(actions[index].elementDescriptors, [{ className: scrollView }]);
  for (const index of scrollAndClick) assert.deepEqual(actions[index].childElementDescriptors, actions[index + 1].elementDescriptors);
  assert.deepEqual(actions[saveScroll].childElementDescriptors, saveTarget);

  const closeMenu = menu.match(/accessibilityLabel="(Close player menu)"/)[1];
  const close = click({ className: button, description: closeMenu });
  assert.ok(actions.slice(back + 1, close).some(action => action.eventType === 'VIEW_CLICKED'
    && matches(action.elementDescriptors[0], { className: button, description: openMenu })));
});

test('Robo keeps automation in one session and requires all non-setup targets', () => {
  assert.deepEqual(execution, { executionMode: { strict: true, notify: false }, postscript: { terminate: true } });
  const onboarding = read('ExpoLyrics/components/onboarding/onboarding-screen.tsx');
  const tour = read('ExpoLyrics/components/onboarding/player-tour-overlay.tsx');
  assert.match(onboarding, />Skip<\/Text>/);
  const tourSkip = tour.match(/accessibilityLabel="(Skip player tour)"/)[1];
  const skip = click({ text: 'Skip' }, true);
  const skipTour = click({ className: button, description: tourSkip }, true);
  assert.deepEqual(actions.flatMap((action, index) => action.optional ? [index] : []), [skip, skipTour]);

  const eventTypes = new Set(['VIEW_CLICKED', scrollIntoView, 'WAIT', 'ASSERTION', 'TAKE_SCREENSHOT', 'PRESSED_BACK']);
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
});
