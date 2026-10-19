/**
 * The whitelist reader must follow the *booted* profile, not the Electron one.
 *
 * Regression for 0.3.6: `profilePatchPath()` hard-coded
 * `profiles/desktop/cordis.patch.yml`, so on a `dsh web` install the file did
 * not exist, `readAllowlist()` returned `undefined`, the panel showed
 * "0 条 / 0 个 provider", and every "按白名单" combo generation failed with
 * "白名单里没有这个类别的成员".
 *
 *   node --test tests/
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasAllowlistBlock, resetProfilePatchCache, resolveProfilePatchPath } from '../lib/profile-patch.js';

const BLOCK = [
  '- id: subagent-model-selection-settings',
  '  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"',
  '  config:',
  '    enabled: true',
  '    allowedModels:',
  '      - provider: buddy',
  '        model: deepseek-v4.1-flash',
  '',
].join('\n');
const EMPTY = '[]\n';

/** Build a throwaway DSH home with the given profiles. */
function home(profiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-profile-'));
  for (const [name, text] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(root, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'profiles', name, 'cordis.patch.yml'), text);
  }
  return root;
}

test('finds the profile that actually carries the whitelist', (t) => {
  const root = home({ web: BLOCK, headless: EMPTY });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  assert.equal(
    resolveProfilePatchPath({ home: root, env: {} }),
    path.join(root, 'profiles', 'web', 'cordis.patch.yml'),
  );
});

test('a web-only install never falls back to the missing desktop patch', (t) => {
  const root = home({ web: BLOCK });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  const resolved = resolveProfilePatchPath({ home: root, env: {} });
  assert.ok(fs.existsSync(resolved), `resolved patch must exist: ${resolved}`);
  assert.ok(!resolved.includes(`${path.sep}desktop${path.sep}`));
});

test('the host-reported patch path wins over scanning', (t) => {
  const root = home({ web: BLOCK, headless: EMPTY });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  const hint = path.join(root, 'profiles', 'headless', 'cordis.patch.yml');
  assert.equal(resolveProfilePatchPath({ home: root, hint, env: {} }), hint);
});

test('a profile without a whitelist reads as unconstrained, not as another profile', (t) => {
  const root = home({ web: BLOCK, headless: EMPTY });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  const hint = path.join(root, 'profiles', 'headless', 'cordis.patch.yml');
  assert.equal(hasAllowlistBlock(fs.readFileSync(resolveProfilePatchPath({ home: root, hint, env: {} }), 'utf8')), false);
});

test('DSH_PROFILE selects the profile by name', (t) => {
  const root = home({ web: BLOCK, headless: EMPTY });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  assert.equal(
    resolveProfilePatchPath({ home: root, env: { DSH_PROFILE: 'headless' } }),
    path.join(root, 'profiles', 'headless', 'cordis.patch.yml'),
  );
});

test('the explicit patch override beats everything', (t) => {
  const root = home({ web: BLOCK });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  const explicit = path.join(root, 'profiles', 'web', 'cordis.patch.yml');
  assert.equal(
    resolveProfilePatchPath({ home: root, hint: '/nonexistent/patch.yml', env: { DSH_QUOTA_FAILOVER_PROFILE_PATCH: explicit } }),
    explicit,
  );
});

test('an empty home still yields a path (so the panel can show what it read)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetProfilePatchCache();
  const resolved = resolveProfilePatchPath({ home: root, env: {} });
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.endsWith('cordis.patch.yml'));
});
