// Expo config plugin: turn off Xcode's "User Script Sandboxing" on the app
// target. Xcode 15+ defaults it ON, and under it the React Native
// "Bundle React Native code and images" phase cannot write `ip.txt` into
// the .app on DEVICE builds ("Operation not permitted"), so
// `expo run:ios --device` fails while simulator builds (which skip that
// write) pass. Pods already get NO from react_native_post_install; this
// applies the same to CFOAI itself and survives `expo prebuild --clean`.
const { withXcodeProject } = require("expo/config-plugins");

module.exports = function withoutScriptSandbox(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const configs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const entry = configs[key];
      if (entry && typeof entry === "object" && entry.buildSettings) {
        entry.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING = "NO";
      }
    }
    return cfg;
  });
};
