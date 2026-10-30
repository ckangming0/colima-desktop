// Bundle the React/Motion islands (ui/islands.jsx) into gen/islands.{js,css} for the renderer.
// Plain IIFE, no eval or code splitting, so it runs under the page's `script-src 'self'` CSP.
const esbuild = require('esbuild');
const path = require('path');

const options = {
  entryPoints: [path.join(__dirname, '..', 'ui', 'islands.jsx')],
  outfile: path.join(__dirname, '..', 'gen', 'islands.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

if (require.main === module) esbuild.build(options).catch(() => process.exit(1));
module.exports = { options };
