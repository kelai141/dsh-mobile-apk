# 构建链与门禁自身的六个 P2 缺陷（issue #1613 / #1614 / #1615 / #1616 / #1580 / #1581）

六条都在**门禁/构建链自身**（L2 安全敏感面）：它们的失效方式不是「判红判错」，而是
「该判红的地方永远绿」。共同真因是同一类——**判据的输入或顺序让它看不见失败**。

## 逐条真因与修法

### #1614 workflow 输入内插进 bash 双引号

`build-apk.yml` 唯一一处把 `${{ github.event.inputs.suffix }}` 直接写进 `run:` 的双引号里。
双引号**不阻止命令替换**：`suffix=$(curl …|sh)` 会以该 job 身份执行；反过来 `$VAR` 形态的
suffix 又会被 shell 先展开 —— 输入既不是数据，也不是原文。同文件其余步骤都走 `env:`，只有这处直插。

修法：改走 `env: SUFFIX` + `--suffix "$SUFFIX"`。判据是**行为**判据：从真实 workflow 抽出该步骤，
用敌意 suffix 真跑一遍（node 换成记录实参的桩），要求 payload 不出现且实参逐字节等于输入；
反证是改回内插写法后 payload **必须**出现。

### #1613 注入失败只判「文件存在」

`python $injectPy … | Select-Object -Last 3` 把退出码完全丢弃，判据只剩 `Test-Path $outTmp`。
`inject-snapshot.py` 用 tarfile 流式写 `.new`，中途抛错会留下**存在但截断**的 `.new`，
紧接着 `Move-Item` 就把原输入覆盖掉。下游聚合门禁能拦「解不开」，拦不掉「解得开、少了一批条目」。

修法：先收 `$LASTEXITCODE`（不再管道直连 Select-Object），非 0 即删半写件并 throw；
再用 `tar -tf` 做成员数对账（退出码为 0 也不代表产物完整）。两条判据各自有一条反证。

### #1615 依赖解析就地重写 lock 且不比对

`npm install --package-lock-only` 会直接改写仓内的 `package-lock.json`；旧实现只把
`inputLockSha256` / `resolvedLockSha256` 记进报告（只记不判），随后 `npm ci` 照着被网络
重写出来的图安装。提交的 lock 缺 `resolved`/`integrity` 时，CI 静默从 registry 补齐而链是绿的。

修法：判据抽成纯函数 `lockRewriteProblem`（相等放行 / 不等判红 / 摘要缺席 fail-closed），
在 `npm ci` **之前**判定，并把「新增/删除/变更」打到日志（差异不能只活在一个哈希里）。
立论与 check-vendor-provenance 同源：锁文件可以变，但必须先在 PR 里显式更新。

实测：仓内 9 个已构建包的 lock 在当前 npm 11.13 下都是**稳定**的（重跑不改写），
所以这条判据不会在现状上恒红。

这条判据有两个面：**判得对**（纯函数可证）与**判在装之前**（顺序，只有真跑才能证）。
Windows 上 Node 拒绝不经 shell 地 spawn `npm.cmd`，真 npm 起不来 —— 于是给安装器留了一条
**只给测试用**的取件缝（`DSH_NPM_TEST_STUB`，正式链不设）：测试注入一个「会改写 lock 的假 npm」，
并断言调用序列是 `['install']`（判红时 `ci` 根本没被调用）而不是 `['install','ci']`。
顺序就此成为可断言的事实，而不是读源码位置得出的结论。

### #1616 导出段在终局判红之前落盘

导出段只看 `Test-Path $apkOut`，不看 `$producedAbis`；而 `$rejectedAbis.Count -gt 0 → exit 1`
在文件末尾，晚于 `Copy-Item` + 写 `.sha256`。arm64 在 assemble **之后**的门禁被拒时，
APK 已落在 `out/v<ver>/`，导出段照样把 `snapshot-arm64.tar.xz` 写进发布目录，然后整链 exit 1。

修法：导出循环前置 `if ($producedAbis -notcontains $abi) { Deny-Abi …; continue }`。
判据从真实脚本抽出导出段，用临时 out/ 与桩驱动四种状态，并带一条「去掉守卫必须恢复落盘」的反证。

### #1580 §1 / §5 空集恒真

两处都是「遍历登记表逐条断言」，登记表为空时循环零次、零条 FAIL，仍打印
`CONTRACT PASS（SKIP=0）`；`--require` 也拦不住（它只拦 `skip()`）。
与已修的 #1021 §4b 同族：删掉登记项比改错登记项更容易通过，而这个方向此前没有任何一层在守。

修法：照 `declarationsProblem` 的形状各加一条前置断言（非数组 / 空集都判红），
`--self-test` 补四例（清空 / 非数组，两段各两例）。

### #1581 esbuild 完整性校验用同一次响应里的哈希

`extractNpmTgz` 用 `dist.sha512`（或 `dist.integrity`）校验刚下下来的 tarball —— 哈希与 tarball
**同源**，被投毒/被劫持的镜像可以同时伪造两者；`if (sha && …)` 还意味着两个字段都缺席时连这条
自证也跳过，直接解包。随后 `esbuildUsable()` 直接执行它，而 `ESBUILD_PIN` 只钉版本字符串、不钉字节。

修法：把 esbuild 与 6 个平台包的 sha512 钉进仓库（`ESBUILD_SHA512`），只认钉住值，
哈希缺席即判红。自证 ⑧ 里加了**端到端**负控：假 registry 对投毒 tarball 返回**自洽的** dist.sha512
（这正是被劫持镜像的能力）——旧实现接受它，修好后拒绝；反向再证「钉住值改成投毒字节的哈希时必须被接受」，
证明判据不是「一律拒绝」。

## 判据失效的两种形态（本轮各踩到一次）

1. **判据只证「有个纯函数」**：⑧ 第一版只用合成输入直接调 `pinnedDigestProblem`，
   把实现改回旧写法它照样绿 —— 因为旧实现根本不调用那个函数。补上端到端负控（假 registry）才承重。
2. **反证被别处顺手拦住**：注入段的「去掉退出码判据」反证一开始没红，因为成员数对账把它拦住了。
   两条判据必须各自用「只有它能看见」的夹具证明承重（退出码非 0 但产物完整 / 退出码 0 但产物截断）。

## 复验

`node scripts/check-code-map.mjs`、`check-release-gates.mjs`、`check-kotlin-comments.mjs`、
`check-build-chain-abort.mjs --self-test`、`check-contract.mjs --self-test`、
`check-browser-syntax-floor.mjs --self-test`，以及三条新增行为判据（各含反证）。
