// ptc-node-wrapper-c1.test.mjs — 缺陷 C（PTC \`code run\` spawn EACCES）修法的静态回归。
//
// 现象：模型在 PTC 里连 \`return 1 + 1;\` 都失败（code run failed / worker-exit）。
// 真因：PTC 给子进程传的是**显式过滤后的 env**（ptc-runtime-node 的 STARTUP_ENVIRONMENT_NAMES 只放
// PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP），LD_LIBRARY_PATH 不在其中 ⇒ 子进程里的 node 找不到
// libz.so.1 等 DT_NEEDED（Permissive 报 CANNOT LINK；Enforcing 真机 app 域 exec app-data ELF 被拒 ⇒ EACCES）。
// 修法 C1：nodeExecutable 指向**快照内的 wrapper 脚本**（非 ELF ⇒ 走 shebang 不触发 app-data ELF exec；
// wrapper 自己 export LD_LIBRARY_PATH ⇒ 不依赖被 tombstone 的继承；linker64 只读取 node 而非 exec）。
//
// 本测试锁四件事（都对**仓库源文件**断言，不需要设备/构建）：
//  ① build-snapshot 生成 wrapper（含正确三行、可执行位、设备路径而非本地 stage 路径）；
//  ② profile 的 nodeExecutable 指向该 wrapper；
//  ③ **反证**：PTC 子进程 env 白名单里不得出现 TERMUX_APP__LEGACY_DATA_DIR
//     （tombstone 残留 + 防「钩子把 wrapper 自己也重定向」这一**未复现但未排除**的风险）；
//  ④ wrapper 就位后，profile 不得再指向裸 bin/node（否则修法被无声回退）。
//
// 用法：node scripts/patches/tests/ptc-node-wrapper-c1.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const BUILD = join(repoRoot, 'scripts', 'build-snapshot-013.mjs')
const PROFILE = join(repoRoot, 'scripts', 'profile-web.cordis.patch.yml')
const WRAPPER_REL = 'libexec/dsh-node'
const PREFIX = '/data/data/com.dsharnessmobile.shell/files/usr'

const build = readFileSync(BUILD, 'utf8')
const profile = readFileSync(PROFILE, 'utf8')

// ① wrapper 生成
check('build-snapshot 生成 PTC wrapper（7c1 段在场）', build.includes('PTC node wrapper'))
check('wrapper 落点为 usr/libexec/dsh-node', build.includes("const PTC_NODE_WRAPPER_REL = 'libexec/dsh-node'"))
// 窗口从 400 放宽到 2000：wrapper 内容会随功能增长（0.14.8 加了堆下限段），
// 而本判据要守的是「同一个 writeFileSync 落了 mode 0o755」，不是「内容必须短」。
// 旧窗口是恒定量，内容一长就假红（实测 0.14.8 堆下限把三段挤到 400 之外）。
check('wrapper 带可执行位（mode 0o755）',
  /writeFileSync\(\s*\n?\s*join\(U, PTC_NODE_WRAPPER_REL\)[\s\S]{0,2000}?\{ mode: 0o755 \}/.test(build))
check('wrapper 用 /system/bin/sh shebang', build.includes("'#!/system/bin/sh\\n'"))
check('wrapper 内部 export LD_LIBRARY_PATH 指向快照 lib', build.includes("'export LD_LIBRARY_PATH=\"' + NEW_PREFIX + '/lib\"\\n'"))
check('wrapper 经 /system/bin/linker64 启动 node（绕开 app-data ELF exec）',
  build.includes("'exec /system/bin/linker64 \"' + NEW_PREFIX + '/bin/node\" \"$@\"\\n'"))
check('wrapper 只烧设备路径、不烧构建期本地路径（NEW_PREFIX 而非 join(U, …)）',
  build.includes("'export LD_LIBRARY_PATH=\"' + NEW_PREFIX") && build.includes("'exec /system/bin/linker64 \"' + NEW_PREFIX"))

// ② profile 接线
check('profile 的 nodeExecutable 指向 wrapper',
  profile.includes('nodeExecutable: ' + PREFIX + '/' + WRAPPER_REL))
check('profile 不再指向裸 bin/node（修法未被无声回退）',
  !profile.includes('nodeExecutable: ' + PREFIX + '/bin/node'))
check('profile 记录了 C1 的逆转条件（上游补白名单后可改回）',
  profile.includes('逆转条件：上游把 LD_LIBRARY_PATH'))

// ③ 反证：PTC env 白名单不得含 TERMUX_APP__LEGACY_DATA_DIR
// 白名单真源在上游产物（快照里跑的是 lib/*.js），但本测试要对**仓库内可断言的东西**下判据：
// 只要我们的构建链/补丁面有人把该变量塞进 PTC env，就必须在这里被拦住。
const PTC_SOURCES = [
  join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'),
]
const ptcPatchText = PTC_SOURCES.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
check('补丁面没有把 TERMUX_APP__LEGACY_DATA_DIR 注入 PTC env',
  !/STARTUP_ENVIRONMENT_NAMES[\s\S]{0,400}TERMUX_APP__LEGACY_DATA_DIR/.test(ptcPatchText))
// wrapper 自身也不得依赖这些被 tombstone 的变量（它是靠自 export 生效，不是靠继承）
const wrapperBlock = build.slice(build.indexOf('const PTC_NODE_WRAPPER_REL'))
  .slice(0, build.slice(build.indexOf('const PTC_NODE_WRAPPER_REL')).indexOf('\n// ──'))
check('wrapper 不依赖 LD_PRELOAD / TERMUX_EXEC__* 继承（只靠自 export）',
  !/LD_PRELOAD|TERMUX_EXEC__/.test(wrapperBlock))
check('wrapper 不引用 TERMUX_APP__LEGACY_DATA_DIR（防「钩子重定向 wrapper 自身」的未复现风险）',
  !wrapperBlock.includes('TERMUX_APP__LEGACY_DATA_DIR'))

// ③-b 0.14.8 堆下限：wrapper 是「被过滤 env」那条路径上唯一的堆来源
// （PTC 只放 6 个环境变量，壳侧 shellEnv() 的 NODE_OPTIONS 到不了它）。
// 判据三条：未设时自适应填值 / 用前先判空（不得覆盖调用方显式值）/ 落在 exec 之前才生效。
check('wrapper 在 NODE_OPTIONS 未设置时才填堆下限（不得覆盖调用方显式值）',
  wrapperBlock.includes('if [ -z "$NODE_OPTIONS" ]; then'))
check('wrapper 按设备 MemTotal 自适应算堆（clamp 到 512-1024MB）',
  wrapperBlock.includes('/proc/meminfo') &&
    /__dsh_mem_kb \/ 2048/.test(wrapperBlock) &&
    wrapperBlock.includes('[ "$__dsh_heap" -lt 512 ]') &&
    wrapperBlock.includes('[ "$__dsh_heap" -gt 1024 ]'))
check('wrapper 导出的堆标志落在 exec 之前（否则对本次进程无效）',
  wrapperBlock.indexOf('export NODE_OPTIONS=') >= 0 &&
    wrapperBlock.indexOf('export NODE_OPTIONS=') < wrapperBlock.indexOf('exec /system/bin/linker64'))

// ④ 双仓镜像：apk 侧同一文件必须含同一 wrapper 落点（防单边演进）
const apkBuild = join(repoRoot, 'dsh-mobile-apk', 'scripts', 'build-snapshot-013.mjs')
if (existsSync(apkBuild)) {
  const ab = readFileSync(apkBuild, 'utf8')
  check('apk 侧 build-snapshot 含同一 wrapper 段', ab.includes('PTC node wrapper'))
  check('apk 侧 build-snapshot 与 coord 逐字节一致（镜像面）', ab === build)
  const apkProfile = join(repoRoot, 'dsh-mobile-apk', 'scripts', 'profile-web.cordis.patch.yml')
  if (existsSync(apkProfile)) {
    check('apk 侧 profile 指向同一 wrapper', readFileSync(apkProfile, 'utf8') === profile)
  }
} else {
  console.log('SKIP(#1)  apk 侧树不在场（单仓检出）——镜像两条跳过')
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
