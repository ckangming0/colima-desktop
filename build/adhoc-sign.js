// electron-builder afterPack hook: ad-hoc sign the bundle so it launches on Apple Silicon.
// For org-wide distribution, replace with a Developer ID identity + notarization.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async ({ appOutDir, packager, electronPlatformName }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
