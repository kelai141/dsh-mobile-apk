# 数组兼容方法可枚举，污染 for...in 遍历（issue #621）

## 现场

#619 把六个 ES2022/ES2023 数组方法补进注入层，用的是 `Array.prototype.x = function ...`。赋值在原型上
创建的是**可枚举**属性，于是装过补丁的旧内核上，普通数组的 `for...in` 多出六个方法名：

```text
期望：0,1
实际：0,1,toSorted,toReversed,toSpliced,with,findLast,findLastIndex
```

六个方法的 `Object.getOwnPropertyDescriptor(...).enumerable` 均为 `true`；同一条缺口还伏在更早的
`Array.prototype.at` 与 `String.prototype.replaceAll` 上。原生内建全部不可枚举，所以这个缺陷**只出现在
装过补丁的旧内核**上，桌面 Chrome 永远复现不了。

## 真因

不是算法错，是**安装方式**错：`AP.x = f` 走的是 CreateDataProperty 的可枚举路径，而固有内建（intrinsic）
按规范必须 `writable: true, enumerable: false, configurable: true`。`#619` 的语义实现与判缺守卫都是对的，
只有属性形态不对。

## 修法

- `dsh-host-web-compat/lib/index.js`：两段数组内建改为经 `defNonEnum(name, fn)` 用 `Object.defineProperty`
  安装（`writable:true, configurable:true, enumerable:false`）；`Array.prototype.at` 与
  `String.prototype.replaceAll` 同步改。判缺守卫、算法、幂等性一律不动，原生在场时仍一个字节都不改。
- `dsh-host-web-compat/scripts/polyfill-property-descriptors.test.mjs`：新增 6 例。在**删掉原生方法的
  realm** 里跑页面实际收到的脚本字节，读描述符并与原生读数逐项对齐（参照系取自同一批内建的原生形态，
  不写死字符串），再断言 `for...in` 只见到 `0,1`、`Object.keys(Array.prototype)` 为空；另有反证、
  可用性、原生不被覆盖、负控与一条源码契约。
- `scripts/smoke-injections.mjs` 与 `scripts/verify-webview-015.mjs`：送达标记改认 `defNonEnum('name'`
  这一形态，改回赋值式安装即判红。
- 版本 0.1.15 -> 0.1.16；`notes.md`、README 双语与 gotchas 356 同步。

## 证据（L1 + L3 面）

```text
$ cd dsh-host-web-compat && npm test
ℹ tests 70  ℹ pass 70  ℹ fail 0
smoke-injections: all checks passed

$ # 负控：把 lib/index.js 换回修前版本（git HEAD）
ℹ tests 6   ℹ pass 4   ℹ fail 2
FAIL 正证：补丁装上后，全部内建与原生一样不可枚举（for...in 只见到下标）
FAIL 源码契约：POLYFILLS 内的内建一律不得用赋值式安装
smoke-injections: 7 check(s) failed（六条数组内建 + at 的送达标记）

$ # 恢复修后版本
ℹ pass 6  ℹ fail 0
```

未做设备验证：本 PR 只改注入脚本的**属性形态**，不改注入点位、不改桥、不改壳侧；老内核行为由 realm
内删原生方法的单测覆盖（与 #619 的同一套判据同源）。真机复核随下个快照补。
