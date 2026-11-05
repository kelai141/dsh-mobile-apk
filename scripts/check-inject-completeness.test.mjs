import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TAR } from './lib/shell.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
/**
 * 合成装配夹具。每个 flag 对应一条 issue #1035 的判据（新增的四个反向用例各自改一处形态）：
 *   - ghostDsh：tar 里多一个**未登记**的 @dsh-android 包（旧实现看不见 → PASSED）；
 *   - declaredSrc：源包 files 字段声明 src/（注入器不携带）→ 声明面发散未登记；
 *   - nonLibImport：lib/**.js 的相对导入指向 lib/ 之外（源包有、注入器不携带 → 旧实现 WARN）；
 *   - extraTarFile：tar 包里多一个源包没有的文件（旧实现按 package.json + lib/ 过滤 → 看不见）。
 */
function fixture({ profiles = ['web', 'headless'], omitRequired = false, ghostDsh = false, declaredSrc = false, nonLibImport = false, extraTarFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'injection-manifest-'));
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    for (const file of ['scripts/check-inject-completeness.mjs', 'scripts/lib/shell.mjs']) {
      copyFileSync(join(sourceRoot, file), join(root, file));
    }
    writeFileSync(join(root, 'scripts/plugin-dirs.json'), JSON.stringify({ dirs: [], externals: ['vendor/active'], retiredExternals: ['vendor/retired'] }));
    const pkg = JSON.stringify({ name: 'active-plugin', version: '1.0.0', type: 'module', ...(declaredSrc ? { files: ['lib', 'src'] } : {}) });
    mkdirSync(join(root, 'vendor/active/lib'), { recursive: true });
    writeFileSync(join(root, 'vendor/active/package.json'), pkg);
    writeFileSync(join(root, 'vendor/active/lib/index.js'), 'export { value } from "./required.js";');
    writeFileSync(join(root, 'vendor/active/lib/required.js'), 'export const value = 1;');
    if (declaredSrc) {
      // files 字段声明了 src/，注入器（inject-all.py）只携带 lib/** + package.json → 声明面发散。
      mkdirSync(join(root, 'vendor/active/src'), { recursive: true });
      writeFileSync(join(root, 'vendor/active/src/ghost.css'), '.ghost { color: red }');
    }
    if (nonLibImport) {
      // lib → lib/ 之外的相对导入：源包有 src/theme.css，但注入器不携带 → 设备上必然缺文件。
      mkdirSync(join(root, 'vendor/active/src'), { recursive: true });
      writeFileSync(join(root, 'vendor/active/src/theme.css'), '.theme { color: blue }');
      writeFileSync(join(root, 'vendor/active/lib/needs-asset.js'), "import '../src/theme.css';\nexport const ok = 1;");
    }
    mkdirSync(join(root, 'vendor/retired/lib'), { recursive: true });
    writeFileSync(join(root, 'vendor/retired/package.json'), JSON.stringify({ name: 'retired-plugin', version: '1.0.0' }));
    writeFileSync(join(root, 'vendor/retired/lib/index.js'), 'retained historical source');
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'home'), { recursive: true });
    for (const profile of profiles) {
      const dest = join(tree, 'home/.dsh/profiles', profile, 'node_modules/active-plugin');
      mkdirSync(join(dest, 'lib'), { recursive: true });
      writeFileSync(join(dest, 'package.json'), pkg);
      for (const file of ['index.js', ...omitRequired ? [] : ['required.js']]) {
        copyFileSync(join(root, 'vendor/active/lib', file), join(dest, 'lib', file));
      }
      if (nonLibImport) copyFileSync(join(root, 'vendor/active/lib/needs-asset.js'), join(dest, 'lib/needs-asset.js'));
      if (extraTarFile) {
        mkdirSync(join(dest, 'src'), { recursive: true });
        writeFileSync(join(dest, 'src/ghost.css'), '.ghost { color: red }');
      }
      if (ghostDsh) {
        const ghost = join(tree, 'home/.dsh/profiles', profile, 'node_modules/@dsh-android/ghost-plugin');
        mkdirSync(join(ghost, 'lib'), { recursive: true });
        writeFileSync(join(ghost, 'package.json'), JSON.stringify({ name: '@dsh-android/ghost-plugin', version: '1.0.0' }));
        writeFileSync(join(ghost, 'lib/index.js'), 'export const applied = true;');
      }
    }
    const archive = join(root, 'fixture.tar');
    execFileSync(TAR, ['-cf', archive, '-C', tree, 'home']);
    return spawnSync(process.execPath, [join(root, 'scripts/check-inject-completeness.mjs'), archive], { encoding: 'utf8', cwd: root });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('retired source may remain without being injected, active packages still match in both profiles', () => {
  const result = fixture();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CHECK-INJECT-COMPLETENESS PASSED/);
});
test('negative control: missing active package in headless still rejects the archive', () => {
  const result = fixture({ profiles: ['web'] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL.*headless.*active-plugin/);
});
test('negative control: missing a required active member still rejects the archive', () => {
  const result = fixture({ omitRequired: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /required\.js/);
});

// ── issue #1035：三处「只看得见清单里登记过的东西」的覆盖面 ────────────────────────
test('#1035 negative control: an unregistered @dsh-android package inside the tar is named and rejected', () => {
  const result = fixture({ ghostDsh: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL.*@dsh-android.*ghost-plugin/);
  assert.match(result.stdout, /未登记/);
});
test('#1035 negative control: files-field surface that the injector does not carry must be registered', () => {
  const result = fixture({ declaredSrc: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /声明面\/注入面发散已登记/);
  assert.match(result.stdout, /src\/ghost\.css/);
});
test('#1035 negative control: a lib -> non-lib dangling import is red, not a WARN', () => {
  const result = fixture({ nonLibImport: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL.*相对导入可解析/);
  assert.match(result.stdout, /目标在 lib\/ 之外/);
  assert.doesNotMatch(result.stdout, /WARN.*needs-asset/);
});
test('#1035 negative control: a file in the tar that the injector never carries is reported as extra', () => {
  const result = fixture({ extraTarFile: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL.*成员集合一致/);
  assert.match(result.stdout, /多 1 项: \[src\/ghost\.css\]/);
});

// ── 真仓接线自证：登记表必须对着真清单，不能自己给自己放行 ───────────────────────────
test('repository manifest keeps undo history separate from the active injection set', () => {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'scripts/plugin-dirs.json'), 'utf8'));
  assert.equal(manifest.externals.includes('vendor/dsh-undo-savepoint'), false);
  assert.equal(manifest.retiredExternals.includes('vendor/dsh-undo-savepoint'), true);
  assert.equal(manifest.externals.includes('vendor/dshmarketplace-plugin'), true);
});
test('#1035: every DECLARED_NOT_INJECTED entry names a real assembly package and carries a reason', () => {
  const gate = readFileSync(join(sourceRoot, 'scripts/check-inject-completeness.mjs'), 'utf8');
  const block = /const DECLARED_NOT_INJECTED = new Map\(\[([\s\S]*?)\n\]\)/.exec(gate);
  assert.ok(block, 'DECLARED_NOT_INJECTED 必须可解析');
  const keys = [...block[1].matchAll(/'(@[^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, '登记表不得为空（否则分歧面全是未登记）');
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'scripts/plugin-dirs.json'), 'utf8'));
  const names = new Set();
  for (const dir of [...(manifest.dirs ?? []), ...(manifest.externals ?? [])]) {
    try { names.add(JSON.parse(readFileSync(join(sourceRoot, dir, 'package.json'), 'utf8')).name) } catch { /* 未构建的包不影响 */ }
  }
  for (const key of keys) assert.ok(names.has(key), 'DECLARED_NOT_INJECTED 的 ' + key + ' 不在真装配集里（改名/移除即登记失效）');
  assert.ok(/reason:/.test(block[1]), '每条登记必须带 reason');
});
