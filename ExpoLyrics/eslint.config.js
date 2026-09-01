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
