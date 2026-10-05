const { withMainActivity } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

// A refresh-rate preference lets Android retain control over power/thermal
// limits. Never request a resolution change or a mode the panel cannot display.
const refreshMethods = `  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    val attributes = window.attributes
    if (hasFocus) {
      val activeDisplay = window.decorView.display ?: return
      val currentMode = activeDisplay.mode
      val preferredRate = activeDisplay.supportedModes
        .filter { it.physicalWidth == currentMode.physicalWidth &&
          it.physicalHeight == currentMode.physicalHeight && it.refreshRate <= 120.1f }
        .maxOfOrNull { it.refreshRate } ?: currentMode.refreshRate
      attributes.preferredRefreshRate = preferredRate
    } else {
      attributes.preferredRefreshRate = 0f
    }
    window.attributes = attributes
  }
`;

function addHighRefreshRate(contents) {
  return mergeContents({
    src: contents,
    newSrc: refreshMethods,
    tag: 'kinesync-high-refresh-rate',
    anchor: /class MainActivity\s*:\s*ReactActivity\(\)\s*\{/,
    offset: 1,
    comment: '//',
  }).contents;
}

module.exports = function withHighRefreshRate(config) {
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') {
      throw new Error('KineSync high refresh rate requires the Kotlin MainActivity template.');
    }
    mod.modResults.contents = addHighRefreshRate(mod.modResults.contents);
    return mod;
  });
};
module.exports.addHighRefreshRate = addHighRefreshRate;
