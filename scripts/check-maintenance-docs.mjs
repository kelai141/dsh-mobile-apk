import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const gradle = read('app/build.gradle.kts');
const required = (pattern, label, source = gradle) => {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`无法读取构建声明 ${label}`);
  return value;
};
const registry = JSON.parse(read('scripts/patches/registry.json'));
const blocks = [
  {
    file: 'docs/AGENTS/DEPENDENCIES.md',
    name: 'gradle-declarations',
    body: [
      `当前源码声明：versionName \`${required(/^\s*versionName\s*=\s*"([^"]+)"/m, 'versionName')}\` / versionCode \`${required(/^\s*versionCode\s*=\s*(\d+)/m, 'versionCode')}\`；suffix 来自 Gradle 属性。此处不证明 APK 产物或验收状态。`,
      '',
      '| 配置 | 声明 |',
      '|---|---|',
      `| AGP | ${required(/id\("com.android.application"\) version "([^"]+)"/, 'AGP', read('build.gradle.kts'))} |`,
      `| Kotlin | ${required(/id\("org.jetbrains.kotlin.android"\) version "([^"]+)"/, 'Kotlin', read('build.gradle.kts'))} |`,
      `| Gradle wrapper | ${required(/gradle-([\d.]+)-bin\.zip/, 'Gradle wrapper', read('gradle/wrapper/gradle-wrapper.properties'))} |`,
      `| Java target | ${required(/targetCompatibility\s*=\s*JavaVersion.VERSION_(\d+)/, 'Java target')} |`,
      `| Termux | ${required(/buildConfigField\("String",\s*"TERMUX_VERSION",[^\n]*?(\d+\.\d+\.\d+)/, 'Termux')} |`,
      ...['compileSdk', 'targetSdk', 'minSdk'].map((key) => `| ${key} | ${required(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'), key)} |`),
      '',
      '| Gradle 范围 | 依赖声明 |',
      '|---|---|',
      // issue #1197：配置名只认 3 个、且只认字面量写法 —— runtimeOnly / api / compileOnly /
      // debugImplementation / platform(...) / libs.* / project(...) 全被静默丢弃，
      // 于是往 build.gradle.kts 加真实依赖，台账一个字都不变而门禁仍报「一致」。
      //
      // 改成**开放配置名**（任意 identifier），但用两条排除把非依赖声明挡掉：
      //   - id("...") / alias(...) 是插件声明，不是依赖；
      //   - create(...) / register(...) 等是 Gradle 任务/容器 API。
      // 参数匹配支持一层嵌套括号（platform("...") / project(":x")）与 libs.xxx 版本目录写法。
      //
      // 不做的事：不解析 libs.versions.toml 展开版本号 —— 那会让台账依赖另一份文件，
      // 而本门禁的职责是「台账与 build.gradle.kts 一致」。版本目录引用如实登记。
      ...(() => {
        const NOT_A_DEPENDENCY = new Set(['id', 'alias', 'create', 'register', 'plugins', 'apply', 'tasks', 'configurations', 'dependencies'])
        const out = []
        const push = (scope, dependency) => {
          if (NOT_A_DEPENDENCY.has(scope)) return
          if (out.some((x) => x.scope === scope && x.dependency === dependency)) return
          out.push({ scope, dependency })
        }
        for (const m of gradle.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*\(\s*platform\s*\(\s*"([^"]+)"\s*\)\s*\)/gm)) push(m[1], 'platform(' + m[2] + ')')
        for (const m of gradle.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*\(\s*project\s*\(\s*"([^"]+)"\s*\)\s*\)/gm)) push(m[1], 'project(' + m[2] + ')')
        for (const m of gradle.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*\(\s*(libs\.[A-Za-z0-9_.]+)\s*\)/gm)) push(m[1], m[2])
        for (const m of gradle.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*\(\s*"([^"]+)"\s*\)/gm)) push(m[1], m[2])
        return out
      })().map(({ scope, dependency }) => `| ${scope} | \`${dependency}\` |`),
    ].join('\n'),
  },
  {
    file: 'docs/AGENTS/RUNTIME-PATCHES.md',
    name: 'active-registry',
    body: [
      '| 活动补丁 ID | scope | 目标 |',
      '|---|---|---|',
      ...registry.patches.map((patch) => `| \`${patch.id}\` | ${patch.scope} | ${[patch.target, ...(patch.additionalTargets ?? [])].map((target) => `\`${target}\``).join('<br>')} |`),
      '',
      `已退役登记：${registry.retired.map((patch) => `\`${patch.id}\``).join('、')}。历史章节保留退役前语义；活动状态以本表和 registry 为准。`,
    ].join('\n'),
  },
];
const write = process.argv.includes('--write');
const failures = [];
for (const { file, name, body } of blocks) {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const contents = read(file);
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex || contents.indexOf(start, startIndex + start.length) >= 0 || contents.indexOf(end, endIndex + end.length) >= 0) {
    throw new Error(`${file}: 缺少唯一生成块 ${name}`);
  }
  const expected = `${start}\n${body}\n${end}`;
  const actual = contents.slice(startIndex, endIndex + end.length);
  if (actual !== expected) {
    if (write) fs.writeFileSync(path.join(root, file), contents.slice(0, startIndex) + expected + contents.slice(endIndex + end.length));
    else failures.push(`${file}: ${name} 与源码不一致；运行 node scripts/check-maintenance-docs.mjs --write`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(write ? '维护文档生成块已对齐源码' : '维护文档生成块与源码一致');