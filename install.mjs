#!/usr/bin/env node
/**
 * dsh-quota-failover — self-installer.
 *
 * Run this once from the plugin directory (`node install.mjs`) and the plugin
 * is installed into a DSH profile with no manual file surgery:
 *
 *   1. copies the runtime files into `<profile>/node_modules/dsh-quota-failover`
 *      (the profile's own resolution root, so no workspace/pnpm required);
 *   2. declares the package as a `file:` dependency of the profile, so a later
 *      `pnpm install` / `pnpm prune` does not consider it extraneous;
 *   3. appends the package name to `dsh.profile.bundles`, so the profile's
 *      bundle layer applies `cordis.patch.yml` (which inserts the loader row)
 *      and the web client half is served — this is also what makes it appear on
 *      the 插件 page instead of hiding as a stray dependency.
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 *   node install.mjs                 # profile "desktop"
 *   node install.mjs --profile web   # another profile
 *   node install.mjs --uninstall     # remove the bundle entry + dependency
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-quota-failover';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE = option('--profile', 'desktop');
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE);
const TARGET = path.join(PROFILE_DIR, 'node_modules', PKG);
const FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/combo/adapter.js',
  'lib/combo/catalog.js',
  'lib/combo/classify.js',
  'lib/combo/combos.js',
  'install.mjs',
  'README.md',
];

function log(line) {
  process.stdout.write(`${line}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
}

function main() {
  if (!fs.existsSync(PROFILE_DIR)) {
    log(`✗ profile not found: ${PROFILE_DIR}`);
    log('  pass --profile <name>, or set DSH_HOME if the harness lives elsewhere.');
    process.exitCode = 1;
    return;
  }

  const profileJsonPath = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(profileJsonPath)) {
    log(`✗ profile has no package.json: ${profileJsonPath}`);
    process.exitCode = 1;
    return;
  }

  const uninstall = flag('--uninstall');
  const profile = readJson(profileJsonPath);
  const before = JSON.stringify(profile);

  const bundles = profile.dsh?.profile?.bundles ?? [];
  const dependencies = profile.dependencies ?? {};
  const fileSpec = `file:${HERE.replace(/\\/g, '/')}`;

  if (uninstall) {
    profile.dsh = profile.dsh ?? {};
    profile.dsh.profile = profile.dsh.profile ?? {};
    profile.dsh.profile.bundles = bundles.filter((entry) => entry !== PKG);
    if (dependencies[PKG] !== undefined) delete dependencies[PKG];
    profile.dependencies = dependencies;
    if (JSON.stringify(profile) !== before) {
      fs.writeFileSync(`${profileJsonPath}.bak-${Date.now()}`, `${JSON.stringify(JSON.parse(before), undefined, 2)}\n`, 'utf8');
      writeJson(profileJsonPath, profile);
    }
    if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
    log(`✓ ${PKG} removed from profile "${PROFILE}"`);
    log('  the running host drops it on the next recomposition (toggle any plugin, or restart DSH).');
    return;
  }

  // 1. copy the runtime tree into the profile's resolution root
  fs.mkdirSync(path.join(TARGET, 'lib'), { recursive: true });
  for (const rel of FILES) {
    const from = path.join(HERE, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // Explicit copy, never a rename/link: the source tree may be hard-linked to
    // an older copy, and a rename would hand the old content forward.
    fs.writeFileSync(to, fs.readFileSync(from));
  }
  log(`✓ copied into ${TARGET}`);

  // 1b. the bundle patch row is resolved RELATIVE to the installed patch file
  // by the DSH loader, so it keeps working when pnpm re-materialises this
  // package from its source (which would otherwise copy the repository's
  // template over the installed row).
  const patchRow = './lib/index.js';
  const patchText = [
    '# dsh-quota-failover bundle patch.',
    '# Relative name: DSH anchors it beside this patch file, so it resolves to',
    '# <package>/lib/index.js and survives pnpm re-materialisation.',
    '- insert:',
    '    - id: dsh-quota-failover',
    `      name: "${patchRow}"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(TARGET, 'cordis.patch.yml'), patchText, 'utf8');
  log(`✓ bundle patch row -> ${patchRow}`);

  // 2. declare the dependency so pnpm keeps it
  profile.dependencies = dependencies;
  dependencies[PKG] = fileSpec;

  // 3. list it as a profile bundle so its patch layer + client half apply
  profile.dsh = profile.dsh ?? {};
  profile.dsh.profile = profile.dsh.profile ?? {};
  profile.dsh.profile.bundles = bundles.includes(PKG) ? bundles : [...bundles, PKG];

  if (JSON.stringify(profile) !== before) {
    fs.writeFileSync(`${profileJsonPath}.bak-${Date.now()}`, `${JSON.stringify(JSON.parse(before), undefined, 2)}\n`, 'utf8');
    writeJson(profileJsonPath, profile);
    log(`✓ profile ${profileJsonPath} updated (dependency + dsh.profile.bundles)`);
    log('  backup written next to it.');
  } else {
    log('✓ profile already declares the dependency and the bundle — nothing to change');
  }

  log('');
  log('Next: the host recomposes from the patch layer. Either');
  log('  • toggle any plugin off/on on the 插件 page (fastest), or');
  log('  • restart DSH.');
  log('Then open 设置 → 额度转移 to configure it.');
}

main();
