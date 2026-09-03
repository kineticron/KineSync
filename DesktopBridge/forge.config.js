const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const appIconBase = path.join(__dirname, 'src', 'assets', 'icon.ico');
const signingCertificateFile = String(process.env.WINDOWS_CERTIFICATE_FILE || '').trim();
const signingCertificatePassword = String(process.env.WINDOWS_CERTIFICATE_PASSWORD || '');

if (signingCertificateFile && !signingCertificatePassword) {
  throw new Error('WINDOWS_CERTIFICATE_FILE requires WINDOWS_CERTIFICATE_PASSWORD.');
}
if (!signingCertificateFile && signingCertificatePassword) {
  throw new Error('WINDOWS_CERTIFICATE_PASSWORD requires WINDOWS_CERTIFICATE_FILE.');
}

module.exports = {
  packagerConfig: {
    asar: {
      // Native addons and files passed to an external process cannot be read
      // from inside app.asar. Keep the runtime payload in app.asar.unpacked.
      // The auto-unpack-natives plugin extends this glob with its .node rule.
      unpack: 'native/**/*.{node,dll,json}',
    },
    icon: appIconBase,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // Stable filename for docs and direct user downloads.
        setupExe: 'KineSync-Desktop-Windows-Setup.exe',
        ...(signingCertificateFile
          ? {
              certificateFile: signingCertificateFile,
              certificatePassword: signingCertificatePassword,
            }
          : {}),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
