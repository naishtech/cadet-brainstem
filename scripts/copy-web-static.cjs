// Copy the built Vue SPA (web/dist) into the package output so the dashboard
// server can serve it offline (Task 55, design §11). Runs after `tsup` via the
// `postbuild` npm script. Cross-platform (uses fs.cpSync, no shell).
const { cpSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const src = resolve(__dirname, '..', 'web', 'dist');
const dest = resolve(__dirname, '..', 'dist', 'dashboard', 'static');

if (!existsSync(src)) {
  console.warn(
    '[copy-web-static] web/dist not found; skipping. Build it with: cd web && npm run build',
  );
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-web-static] copied ${src} -> ${dest}`);
