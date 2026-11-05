# FileProvider 宽映射缺少调用点封口

## 现象

`file_paths.xml` 当前把整个外部存储根映射到 FileProvider（`external-path path="."`）。已有 manifest hardening 门禁检查组件导出、网络安全和备份规则，但新增 `getUriForFile` 调用点不会触发它。

## 真因

FileProvider 的路径映射决定可生成 URI 的文件范围。现有宽映射是为用户主动选择文件后的 chooser 保留；若后来新增调用点，单靠映射 XML 和运行时少数业务白名单无法证明新调用点也受同等约束。此前门禁没有把实际 manifest 引用的 paths XML 与 URI 创建源码关联起来。

## 修法

`check-manifest-hardening.mjs` 现在从 manifest 的 `android.support.FILE_PROVIDER_PATHS` metadata 读取实际资源，识别回到基目录、越出基目录和 `root-path` 映射。存在宽映射时，它递归扫描 Java/Kotlin 源码，并对 `getUriForFile` 引用的包内相对路径和数量做精确登记；未知文件、新增引用、缺失引用或扫描读取失败都会使门禁失败。登记项附带每类调用的用途说明。窄目录映射不启用这项调用点清单。PR CI 同时运行该门禁的 `--self-test` 与真实源码树判据。

这个静态门禁锁住调用点集合；FileIncoming、PathOpen、LogShare 等各自的运行时范围与内容检查继续负责校验具体文件。

## 复验证据

- `node --check scripts/check-manifest-hardening.mjs`：通过。
- `node scripts/check-manifest-hardening.mjs --self-test`：通过，覆盖根/窄映射判定、递归源码扫描、未知调用文件、已登记文件新增或删除调用、普通与原始字符串插值形态计数、manifest resource 读取。
- `node scripts/check-manifest-hardening.mjs`：通过当前宽 `external-path` 与四个已登记 URI 创建文件。
- 设备验证未做：本改动只影响构建期静态门禁，不改 APK 运行时行为。
