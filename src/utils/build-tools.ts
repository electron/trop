import * as path from 'path';

// trop's repository root: this module lives at src/utils/ (tests) or
// lib/utils/ (build output), both two levels below it.
const tropRoot = path.resolve(__dirname, '..', '..');

// electron/build-tools is vendored into `.build-tools/` by
// scripts/ensure-build-tools.js (trop's postinstall) at the commit pinned in
// package.json, which is the single source of truth for the pin. Sandbox
// jobs register its `.patches` list merge driver on the clone they backport in.
export const BUILD_TOOLS_DIR = path.join(tropRoot, '.build-tools');
