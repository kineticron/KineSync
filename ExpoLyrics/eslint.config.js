// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // React Compiler is disabled while Reanimated shared values and gesture
    // callbacks still use mutation patterns that the compiler cannot transform.
    rules: {
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // Press feedback and scrolling must stay on the native, platform-delayed
    // path. Legacy JS touchables opt back into touch-down feedback. RN scroll
    // owners and Pressables are exceptions only where a responder owner or a
    // measurement surface cannot use the gesture handler, and every exception
    // carries an inline disable with its reason. Type-only imports are allowed
    // because they do not create a runtime press or scroll surface.
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              allowTypeImports: true,
              importNames: [
                'TouchableOpacity',
                'TouchableHighlight',
                'TouchableWithoutFeedback',
                'TouchableNativeFeedback',
                'Pressable',
                'ScrollView',
                'FlatList',
                'SectionList',
              ],
              message:
                'Use NativeTouchable or a react-native-gesture-handler scroller for native press and scroll ownership. Document any responder-owning exception inline.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'scripts/verify-spotify-browser-metadata.js',
    ],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
      },
    },
  },
]);
