# DSH 工作区 Git 对象读取探针

上游 `packages/deliverables/workspace-changes/src/git.ts` 通过 Git 查找树条目并读取 blob。每次读取有子进程启动开销。本探针对同一只读负载比较 Rust `gix` 和持久的 `git cat-file --batch`；后者有无应用对象缓存各跑一组，缓存上限是 4096 个对象和 8 MiB 内容。

两侧用同一遍历器展开两个提交的树，再读取并核对路径、模式、对象标识和 blob 内容摘要。合成仓分别以松散和打包对象运行，覆盖字面通配符、制表符、中文、空格、重命名、二进制、空对象及不存在的对象。仅真正找不到对象才算缺失；解析或 I/O 失败会中止运行。真实仓库是两份固定的 DSH 源码树，用全树和 blob 读取放大差异。产品通常只读变更路径，因此这里的时间不是一次 DSH 用户操作的延迟。

2026-11-09，在隔离 Android Studio AVD（API 35，主 ABI x86_64）中用调试 APK 的应用 UID 运行。Git 对照用随包 Git 2.56.0 的真实可执行文件。三个变体在每种样本上的摘要及负控一致。首轮为一次观测；热 p50 使用探针的最近秩口径。

| 样本 | Rust 首轮 / 热 p50 | Git 批处理首轮 / 热 p50 | Git 批处理加缓存首轮 / 热 p50 |
| --- | ---: | ---: | ---: |
| 合成松散对象，20 次热读 | 43.29 / 4.87 ms | 451.91 / 265.19 ms | 219.04 / 3.01 ms |
| 合成打包对象，20 次热读 | 132.44 / 3.03 ms | 466.76 / 6.37 ms | 363.79 / 21.94 ms |
| 上游打包对象，4 次热读 | 8.99 / 6.68 s | 32.70 / 19.89 s | 16.46 / 33.34 s |

上游负载使用 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` 和 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，合并去重后读取 22,732 个路径与对象组合，共 180,618,365 字节。Rust 对这组负载有优势；小样本波动较大，不能从单次首轮推断固定节省。本轮未测 RSS、CPU、功耗和 arm64 设备。原始报告：[松散](evidence/loose-x86_64.json)、[打包](evidence/packed-x86_64.json)、[上游](evidence/upstream-x86_64.json)。

CI 编译 Android 两种 ABI 并检查 16 KiB ELF 对齐。主机自检：

```sh
cargo build --locked --release --manifest-path scripts/android-native/git-read-probe/Cargo.toml
node scripts/android-native/git-read-probe/verify-fixture.mjs <binary>
```

设备复测：用 `make-fixture.mjs <output>` 生成合成仓，或用 Git 创建只含指定上游提交的浅 bare 仓。将二进制和仓库复制到独立调试 APK 的缓存，使用应用 UID 从数据根目录通过 `/system/bin/linker64` 启动探针。三个变体均传 `--repo <git-dir> --base <sha> --head <sha> --iterations 1 --warm-iterations <n>`，分别选择 `--engine gix`、`--engine batch --git <git.real> --git-lib <lib>` 及后者加 `--cache-blobs`。真实上游仓还传 `--tree-only` 以关闭合成样本专有字段的必备检查；仍会读 blob。首轮只指新建进程或句柄，未清理系统文件缓存。热样本复用仓库句柄或同一个 Git 子进程。

本探针不接入产品路径。未来接入要测真实变更列表与补丁读取，验证 linked worktree、alternate object store、替换引用、SHA-256 仓、读取预算、取消及错误传播；对象写入和 Git 配置仍由上游实现处理。
