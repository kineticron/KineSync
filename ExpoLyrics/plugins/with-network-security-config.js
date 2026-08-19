const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Android cannot express an allow-list for all RFC1918 addresses. Permit the
// transport so zero-config LAN ws:// pairing keeps working; the app URL
// validator still rejects cleartext connections to every public host.
module.exports = function withNetworkSecurityConfig(config) {
  config = withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (app) app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const resourceDir = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.writeFileSync(path.join(resourceDir, 'network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>`);
    return mod;
  }]);
};
