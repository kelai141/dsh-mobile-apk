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
      ...Array.from(gradle.matchAll(/^\s*(implementation|testImplementation|androidTestImplementation)\("([^"]+)"\)/gm), ([, scope, dependency]) => `| ${scope} | \`${dependency}\` |`),
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
