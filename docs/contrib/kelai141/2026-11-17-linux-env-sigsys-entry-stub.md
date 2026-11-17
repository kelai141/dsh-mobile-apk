# Linux 环境：入口 stub 把 SIGSYS 处理器装到装载器第一行之前（2026-11-17）

> 状态：**方案 + 可行性原型**。原型只离线验证了「注入结构」与「时序」（§9 的 G1–G3），
> 真机端到端未验，本机 qemu 8.2 在这条路径上有缺陷（§9.4）。尚未进任何版本。
> 一句话：现在能启动，但「任意被拦调用都会杀进程」这一层还没兜住；兜住它的唯一位置是
> 装载器（ld.so）的入口。
> 前置阅读：[2026-11-16-linux-env-seccomp-sigsys.md](2026-11-16-linux-env-seccomp-sigsys.md)
> （根因与 0.10.7 修复）、[2026-11-16-linux-env-arm64-handoff.md](2026-11-16-linux-env-arm64-handoff.md)
> （现场与复验流程）。

## 1. 结论一句话

**能启动不等于不会死。** 0.10.7 的指令层补丁消掉的是 glibc 启动必经的两个系统调用
（`set_robust_list`、`rseq`），其余被 Android 白名单拦下的调用（`keyctl`、`io_uring_setup`、
SYSV IPC、`mount`……）今天踩到仍然是一条 `Bad system call`。

方案：把 SIGSYS 处理器装到装载器第一行代码**之前** —— 改 loader 的 `e_entry`，指向一段
约 140 字节的 stub；stub 先 `rt_sigaction(SIGSYS)` 装处理器、再 `rt_sigprocmask` 解除
SIGSYS 屏蔽，然后跳回原入口。此后**任意**被 `SECCOMP_RET_TRAP` 拦下的调用都会拿到
`-ENOSYS` 而不是把进程杀掉。代价：每次 exec 多 2 个系统调用；放行的调用零额外指令；
真被拦时每次约 1–3 微秒。

它**不替代**指令层补丁：建线程那条路径里信号是被 block 的，处理器无论如何都救不了
（§3.2），那一层必须靠改指令。

## 2. 人话版根因：被拦的系统调用不是「返回错误」，是「当场杀进程」

### 2.1 先把三个词说清楚

| 词 | 一句话 | 在这里指什么 |
|---|---|---|
| 系统调用 | 程序向内核要服务的唯一入口 | 读文件、建线程、改身份、开 socket 都是 |
| seccomp 过滤器 | 内核里的一张「允许哪些系统调用」的名单，不在名单上就走默认动作 | Android 给每个 app 进程装的那张 |
| 默认动作 `SECCOMP_RET_TRAP` | 内核不发错误码，改成给线程发一个 `SIGSYS`（31 号信号） | 没人处理 = `Bad system call`，退出码 159（128+31） |

所以这不是权限问题：`EPERM` 是「内核拒绝了，但程序还活着，可以降级」；`TRAP` 是
「程序被信号打死，没有返回值可拿」。重试、改路径、加权限都无效，因为内核根本没打算让
这个调用有返回值。

两个会混淆的细节：

- 同一个现象在不同壳里文案不同：应用控制台的 mksh 报 `Unknown signal 31`，外层脚本报
  `Bad system call`，都是 SIGSYS。
- 应用域实测：0..469 里 **243 个调用号**会被这样打死（`set_robust_list` 99、`rseq` 293
  都在其中）。

### 2.2 为什么 glibc 会撞上，bionic 不会

Android 的这张名单是从 bionic **自己用到的**系统调用生成的（`SYSCALLS.TXT` 减 blocklist
加 allowlist），默认动作 `Disallow()` 的唯一实现就是 `SECCOMP_RET_TRAP`，没有
debuggable / userdebug / `ro.*` 之类的放宽分支；过滤器由 Zygote 在 fork 出 app 进程时
装上，之后再想用 `prctl(PR_SET_SECCOMP)` 叠一层也只能**加**、不能减。

Debian 的 glibc 启动时会做两件「向内核登记可选特性」的事：

| 调用 | aarch64 号 | glibc 用它做什么 | 失败会怎样 |
|---|---|---|---|
| `set_robust_list` | 99 | 把当前线程持有的 robust futex 链表登记给内核，线程异常死亡时内核能把锁标成 owner-died 并唤醒等待者 | glibc 静默降级（不登记，也不报错） |
| `rseq` | 293 | 可重启序列（restartable sequences）的登记，glibc 2.35 起 | `_rseq_size = 0`，`cpu_id` 标记 REGISTRATION_FAILED，正常继续 |

两件都是**可选的**：内核没有这些特性时 glibc 有完整降级路径。所以「回答 -ENOSYS」不是
伪造，而是**一个没有这些特性的内核本来就会给出的答案**。这一点很重要，它决定了整个方案
的合法性。

bionic 从不调用这两个号，所以它们**从来不在**那张名单上。不是「某个 Android 版本开始
变严」，是两边从来没对齐过。

（顺带解释一个常见困惑：为什么 `adb shell` 里同一个 Debian rootfs 常常能跑？因为
`shell` 域不经 Zygote，没有这条 app 过滤器。这是从 AOSP 策略文件头注与过滤器唯一安装点
推断出来的，没有官方文档明文。）

### 2.3 所以「装个处理器」这句话难在哪

难在**时间点**。预载库（`LD_PRELOAD`）的代码要等 loader 把一切都铺好才会跑；而这两个
调用发生在铺好**之前** —— loader 给自己的第一个线程做 TLS 初始化时。所以预载库里装处理器
不是「装得不够早」，是开始装的时候进程已经死过一回了。

更要命的是第二条路径：glibc 建新线程时，先把**所有信号 block 掉**，再发
`set_robust_list`。信号被 block 时 TRAP 是致命的 —— 内核把处置复位成默认并终止线程，
实测装好处理器也一样是 159。也就是说这条路径连「处理器有没有机会跑」都谈不上。

## 3. 精确位置：两个调用在装载器里，早于任何用户代码

### 3.1 启动期顺序（一张表看完）

glibc 2.41（Debian trixie 用的就是这个系列），下面行号都是 2.41 源码：

| 次序 | loader 在做什么 | 位置 |
|---|---|---|
| 1 | `LD_PRELOAD` 的 `.so` 只被 mmap 进来，**没有重定位** | `elf/rtld.c:1902-1928` |
| 2 | **主线程 TLS 初始化：发出 `set_robust_list`(99) 与 `rseq`(293)** | `elf/rtld.c:1997` → `init_tls` → `call_tls_init_tp` → `__tls_init_tp`；`sysdeps/nptl/dl-tls_init_tp.c:93`（robust）、`:109-110`（rseq 的 tunable 与注册） |
| 3 | libc 重定位 | `elf/rtld.c:2240` |
| 4 | 其余对象（含 `LD_PRELOAD`）重定位，**`ifunc` resolver 在这一步跑** | `elf/rtld.c:2267` |
| 5 | `__libc_early_init` | `elf/rtld.c:2330`（上一行注释 `Relocation is complete.`） |
| 6 | 构造函数（`DT_INIT` / `DT_INIT_ARRAY`） | `sysdeps/aarch64/dl-start.S:68` → `_dl_init` |

一句话：**任何用户代码**（构造函数、`ifunc` resolver、`LD_AUDIT` 的 `la_version`）都排在
第 2 步之后。所以第 2 步是唯一「必须在还没有用户代码的时候就解决」的窗口；第 4 步之后
的所有调用，只要有处理器就都能救。

另外校正一个流传过的说法：这两个调用**不在** `__libc_early_init` 里（那里只有 ctype 与
single-threaded 标记），所以「覆盖 `__libc_early_init`」也没用 —— 它既不是调用点，ld.so
又走 `GLIBC_PRIVATE` 的内部引用，不经过全局符号查找。

### 3.2 新线程：信号被 block 的那一段

`nptl/pthread_create.c`：

- `:379` `rseq`（`start_thread` 里）
- `:384-389` `set_robust_list`
- `:509` 父线程在 clone **之前**就把全部信号 `SIG_BLOCK`
- `:432` 子线程直到这里才 restore

aarch64 定义了 `__ASSUME_SET_ROBUST_LIST`，所以 `if (__nptl_set_robust_list_avail)`
这段被编译掉 —— **每建一个线程无条件发一次**。实测：4 线程程序共 5 次（1 主 + 4 子），
`GLIBC_TUNABLES` 也改不了它。

结论：这条路径不能用处理器解决（信号 blocked，TRAP 致命），只能靠指令层把调用本身消掉。

### 3.3 handler 依赖的两个硬事实

aarch64 的信号帧偏移（实测与源码 `_Static_assert` 双证，内核 `sigcontext` 与 glibc
`mcontext_t` 逐字段同布局）：

| 字段 | 偏移（字节） |
|---|---|
| `uc_mcontext` | 176 |
| `uc_mcontext.regs[0]`（x0，返回值） | **184** |
| `uc_mcontext.sp` | 432 |
| `uc_mcontext.pc` | **440** |
| `uc_mcontext.pstate` | 448 |
| `sizeof(ucontext_t)` | 4560 |

两个必须记住的语义：

1. **内核在投递 TRAP 时已经把 pc 推过 `svc` 之后**（man seccomp(2) 明说「program counter
   will be as though the system call happened」；aarch64 与 x86_64 实测一致）。所以 handler
   **不要**再给 pc 加 4；保留一次兜底检测即可（见 §6.4）。
2. `pstate` 与 `uc_mcontext.__reserved`（FPSIMD 记录）会被内核校验，改坏就是 badframe →
   SIGSEGV。**只改 `regs[]` 与必要的 pc，别碰那 4096 字节。**

## 4. 现有修复：指令层把这两个调用改成 -ENOSYS（0.10.7，已合并）

`svc #0` 是内联在 loader 与 libc 里的，唯一能改答案的地方就是指令本身：

```
svc #0        (0xd4000001)   ->   movn x0, #37   (0x928004a0)   == -ENOSYS
```

| 位置 | 处数 | 打补丁的时机与工具 | 为什么必须在这 |
|---|---|---|---|
| APK 里那份 loader（guest 程序统一经它启动） | 2（`set_robust_list`、`rseq` 各 1） | 构建期，`dsh-bionilux/scripts/patch-android-glibc.mjs` | 启动必经，且发生时进程里还没有用户代码 |
| guest 的 `libc.so.6` | 3（2×`set_robust_list`、1×`rseq`） | 安装（prepare）阶段，`dsh-bionilux/packages/linux-runtime/modules/libc-seccomp-patch.js` | 每建一个线程都要发 `set_robust_list`，`fork` 子进程还会再登记一次 |

定位方式不依赖固定偏移：在 `svc #0` 前面 12 条指令（glibc syscall 宏的跨度）里找
`movz/movn x8, #99` 或 `#293`。`svc #0` 那条指令被整体换成 `movn x0, #37`：系统调用不再
发起，x0 直接拿到 `-ENOSYS`。

工程约束（这几条是它能长期活下来的原因）：

- **幂等**：按 libc 摘要记账（`var/lib/bionilux/guest-libc-seccomp.json`），重复准备阶段不再改。
- **匹配不到即失败**：`patch-android-glibc.mjs` 在「本该有补丁点却一处都没找到」时退出
  非 0，拒绝把未打补丁的 ELF 发出去；宁可打包失败，也不要退回一个没人能定位的
  `Bad system call`。
- **x86_64 跳过**：那条指令编码是 AArch64 专用，模拟器镜像本身会回答这两个调用。

这条修复解决了**启动**与**建线程**两件事，覆盖了已知的全部 5 个点（loader 2 + guest
libc 3）。它没解决的是：这两个调用**以外**的任何被拦调用。

复核证据（0.10.7 产物）：loader 里 `67380`、`67544` 两处偏移都已是 `0x928004a0`；
`qemu-aarch64 -strace` 里 guest 不再发出 99/293。

## 5. 现有防御纵深与真实缺口

### 5.1 预载库现在覆盖什么

`libbionilux_preload-aarch64.so`（`LD_PRELOAD`，源码 `dsh-bionilux/src/preload/hooks.c`）
是一个普通 libc 符号拦截层，做四类事：

1. **路径映射**：应用交给 libc 的每个路径都按 `BIONILUX_ROOTFS` 解析，guest 看到自己的
   `/usr`、`/etc`、`/var`，而不是宿主 Android 的。
2. **假 root 身份**：`set*id` 家族在库里合成（`setuid`/`seteuid`/`setreuid`/`setresuid`/
   `setgid`/…/`setgroups`/`initgroups`，以及 `chown`/`fchownat` 的 uid/gid），apt 取包前
   的降权就走这条路。
3. **`syscall()` 符号的部分改写**：`libuv` 的 `statx`、以及 `*at` 入口这类绕过命名包装的
   调用，只为 5 个路径类号（`statx`/`newfstatat`/`openat`/`readlinkat`/`readlink`）做语义，
   其余号在汇编里原样转发（不新增栈帧，`clone`/`vfork` 的寄存器路径与 glibc 一致）。
4. 其它：`/proc/self/exe`、`getcwd`、`readlink` 报 guest 路径；`getifaddrs` 绕开 netlink。

它自己写明了边界：**这些只是普通 libc 符号**。通过隐藏别名（hidden alias）的内部调用、
程序自己内联的 `svc`、静态链接的程序，都拦不到。

### 5.2 没覆盖什么

| 缺口 | 说明 |
|---|---|
| glibc 内部其它内联 `svc` | 既不走 `syscall()` 符号，也不走命名包装，直接就是一条 `svc` |
| 别的库 / 程序里的内联 `svc` | Go 的汇编桩、Rust 的 `asm!`、libuv 的探测路径 |
| 静态程序 | 没有 loader，预载库根本不会加载，兜底与映射同时失效 |
| 没被 hook 的 libc 包装 | `keyctl`、`mount`、`io_uring_setup`、`bpf`、SYSV IPC（`semget`/`msgget`/`shmget`…）—— 走的是普通 libc 符号，但预载库没为它们做语义，调用照样落到内核、照样被 TRAP |

在应用域实测被拦的代表号：`mount`(40)、`setgroups`(159)、SYSV IPC 一批（180–197）、
`add_key`/`request_key`/`keyctl`(217/218/219)、`io_uring_setup`(425)。（`unshare`(97) 本身
不在被拦名单里 —— 它得到的是 EPERM 一类的普通错误；但真实负载里它常和后面那批一起出现，
所以 G4 仍然拿它当探针。）

### 5.3 实测：node 一次文件读就踩到 io_uring

在 qemu-aarch64 下跑 aarch64 node，一次 `fs.readFileSync` 就发出 **3 次**
`io_uring_setup`(425) —— libuv 先试 io_uring，拿不到再退回普通读写。

- qemu 把 425 当「未知调用」回 `-ENOSYS`：node 走完回退路径，正常退出（exit 0）并打印
  预期的 `OK 14`。
- 同一段代码在 Android app 域里，425 是 TRAP：**回退代码在，但没有机会跑** —— 进程直接死。

这条实测把「偶发调用」这个词纠正了：它不是罕见角落，普通文件读就会走到，而且每次进程
启动都可能重来。同理还有 node 的线程池、python 的 `os.setgroups`、git 的身份切换。

## 6. 方案：入口 stub

### 6.1 为什么只剩这一个位置

§3.1 的表已经把用户态钩子全数排除：任何在预载库里的代码都晚于第 2 步。进程外机制
（ptrace、翻译层）虽然够早，但按调用计费（§8）。剩下唯一可改的是内核把控制权交进用户态
的那个地址 —— loader 的 `e_entry`，也就是**第一条用户态指令**。在它之前没有任何用户代码，
所以「比 loader 第一行更早」在这里等价于「改这个字段」。

### 6.2 注入：不动段表，只改 3 个字段

Debian trixie glibc 2.41 aarch64 的 `ld-linux-aarch64.so.1`（201344 字节，9 个程序头）：

- `e_entry = 0x1b2c0`（入口是 `bti c; mov x29, #0; mov x30, #0; mov x0, sp; bl _dl_start`）；
- `LOAD#0` 覆盖文件 `0x0..0x27460`（R E）；
- 下一个段从文件 `0x2e898` 开始 —— 于是 `0x27460..0x2e898` 这约 29 KB **没有任何段覆盖、
  整段零填充**。

所以注入只需要三处改动，不新增程序头、不搬段：

1. 把 stub（原型 140 字节）写进 cave（`0x27460`）；
2. `e_entry = cave`；
3. `LOAD#0` 的 `p_filesz` 与 `p_memsz` 一起扩到 `cave + len`（`0x274ec`）。

其它必须照顾的细节：

- 该 loader 带 `GNU_PROPERTY: AArch64 feature: BTI, PAC`：stub 首条加 `bti c`（非 BTI
  机器上是 NOP）；跳回原入口用**直接分支 `b`**（不做 BTI 检查）。handler 由内核直接置
  PC，不需要 BTI pad。
- 全部寻址用 `adr`（PC 相对），stub 里没有重定位。
- 落点：`dsh-bionilux/scripts/inject-sigsys-stub.mjs`（与 `patch-android-glibc.mjs`
  同风格，新增）；stub 汇编源码入库并附构建命令；记账沿用现有思路写
  `var/lib/bionilux/loader-sigsys-stub.json`（loader sha256 + glibc 版本 + `e_entry`
  + stub 版本）。
- **未知版本必须失败**：`e_entry`、`LOAD#0` 的起点/长度、cave 是否全零，任一不符就退出
  非 0，不静默跳过。

### 6.3 stub 本体：先装处理器，再解屏蔽，然后跳回

```asm
_stub:                          ; 新的 e_entry，运行时地址 = load_base + cave
    bti     c
    sub     sp, sp, #112        ; 保存 x0-x9（112 保持 16 字节对齐）
    stp     x0, x1, [sp, #0]
    stp     x2, x3, [sp, #16]
    stp     x4, x5, [sp, #32]
    stp     x6, x7, [sp, #48]
    stp     x8, x9, [sp, #64]
    ; (1) 装处理器：ksa 在栈上构造，handler 用 adr 取，全 PC 相对
    adr     x4, sigsys_handler
    mov     x5, #4              ; SA_SIGINFO
    stp     x4, x5, [sp, #80]   ; handler, flags
    stp     xzr, xzr, [sp, #96] ; restorer = 0, sa_mask = 0（各 8 字节）
    add     x1, sp, #80
    mov     x0, #31             ; SIGSYS
    mov     x2, #0
    mov     x3, #8              ; sigsetsize
    mov     x8, #134            ; rt_sigaction
    svc     #0
    ; (2) 解除 SIGSYS 屏蔽：exec 继承父进程的信号屏蔽字，不能假设它是空的
    adr     x1, sigsys_set      ; { .quad 1 << 30 }，SIGSYS = 31
    mov     x0, #1              ; SIG_UNBLOCK（Linux 值：SIG_BLOCK=0, SIG_UNBLOCK=1）
    mov     x2, #0
    mov     x3, #8
    mov     x8, #135            ; rt_sigprocmask
    svc     #0
    ; (3) 恢复寄存器并跳回原入口（直接分支；位移由 patcher 填）
    ldp     x0, x1, [sp, #0]
    ldp     x2, x3, [sp, #16]
    ldp     x4, x5, [sp, #32]
    ldp     x6, x7, [sp, #48]
    ldp     x8, x9, [sp, #64]
    add     sp, sp, #112
    b       <原 e_entry>

sigsys_handler:                 ; 内核直接置 PC，不需要 BTI pad
    ldr     w3, [x1, #8]        ; siginfo.si_code
    cmp     w3, #1              ; SYS_SECCOMP
    b.ne    pass_through
    ldr     w3, [x1, #4]        ; siginfo.si_errno == SECCOMP_RET_DATA
    cbnz    w3, pass_through    ; 带 tag 的（guest 自己的过滤器）不接管
    ldr     x3, [x2, #440]      ; pc
    ldr     w4, [x3]
    movz    w5, #0xd400
    movk    w5, #0x0001         ; "svc #0" 的编码
    cmp     w4, w5
    b.ne    1f
    add     x3, x3, #4          ; 兜底：实测内核已推进 pc，正常不触发
    str     x3, [x2, #440]
1:  mov     x3, #-38            ; -ENOSYS
    str     x3, [x2, #184]      ; uc_mcontext.regs[0]
    ret
pass_through:
    ; 不接管（判定见 §6.4）：把处置改回 SIG_DFL 再给自己重投一个 SIGSYS，
    ; 让默认动作（终止）生效。正式版在这里补 rt_sigaction(SIGSYS, SIG_DFL)
    ; + getpid/gettid + tgkill；无论如何都不能直接 ret —— 那等于把 guest
    ; 自己的 seccomp 信号吞掉。

    .balign 8
sigsys_set:
    .quad   1 << 30             ; SIGSYS(31) 对应第 30 位
```

顺序是**先装处理器、再解屏蔽**：解除屏蔽那一刻处理器已经就位；两者之间没有系统调用，
不会留下窗口。

原型（`stub_arm64.S`，140 B）只有 `rt_sigaction` 一步，没有解屏蔽与 `si_code` 判定；
正式版补上后预计不超过 200 字节，cave 足够（约 29 KB）。

### 6.4 handler 规则

| 条件 | 动作 |
|---|---|
| `si_code != SYS_SECCOMP`（不是 seccomp 产生的） | 不接管：还原默认处置并重投递 |
| `si_errno != 0`（带 tag = guest 自己的 seccomp 过滤器） | 不接管：同上，不吞 |
| 被拦号属于 `set*id` 家族（aarch64 143–152 的 set 项与 159 `setgroups`） | `regs[0] = 0`（合成成功） |
| 其余 `si_code == SYS_SECCOMP && si_errno == 0` | `regs[0] = -ENOSYS`（`-38`），不改 pc |

为什么这样定：

- **只认 `si_errno == 0`**：Android 的策略 `Disallow()` 不带数据，所以 tag 恒为 0；带 tag
  的信号是 guest 自己叠的过滤器产生的，语义应该交回 guest（cortex / DroidDeck 的 proot
  `0027` 补丁就是为这个）。本仓目标负载（apt/dpkg/git/node/python）不自建过滤器；真遇到
  再按链回 guest 处理器实现。
- **不改 pc**：§3.3 已说明内核已推进 pc；兜底检测留着，只是防止未来内核语义变化。
- **`set*id` 回 0 而不是 ENOSYS**：与预载库的假 root 保持一致，理由见 §11.3。

实现时别踩的坑：

- 内核 ABI 的 `struct sigaction` 字段顺序是 **handler / flags / restorer / mask**（不是
  glibc 头文件里的那个顺序），`sigsetsize = 8`；`SA_SIGINFO = 4`。
- `SYS_SECCOMP` 这个 `si_code` 常量 glibc 头文件里没有，自己 `#define` 成 1。
- 不设 `SA_RESTORER` 时，返回路径由内核用 arm64 vDSO 的 sigtramp 兜；要完全不依赖它，
  就自己放一个 `mov x8, #139; svc #0`（`rt_sigreturn`）的 restorer 并把 `SA_RESTORER`
  置位。两种都行，但要在真机上确认过再定。
- 信号屏蔽与 `pstate` / `__reserved` 一律不碰（§3.3）。

**守卫**：预载库要拦 guest 的 `sigaction`/`rt_sigaction`/`signal`/`sigprocmask`/
`pthread_sigmask`，不允许把 SIGSYS 改回默认或加进屏蔽 —— 否则 guest 一行代码就能把兜底
拆掉。这是「处理器生在进程内」的固有权衡，cortex 同款做法。

### 6.5 与指令层补丁的分工和代价

| 层 | 负责 | 为什么不能换 |
|---|---|---|
| 指令层（0.10.7） | 已知的、每次启动/每个线程**必发**的 5 个点 | 建线程时信号被 block，handler 救不了；而且它零成本 |
| 入口 stub | 其余一切被 TRAP 的调用（运行期偶发 + 未来 glibc 新加的） | 只有它能在那之前装好处理器 |

净收益：覆盖范围从「2 个调用」变成「任意被拦调用」，稳态开销不变。

| 场景 | 代价 |
|---|---|
| 每次 exec | +2 个系统调用（`rt_sigaction`、`rt_sigprocmask`），一次性 |
| 放行的系统调用 | 0 条额外指令 —— handler 正常情况一次都不会被调用 |
| 真被拦一次 | 1 次信号投递 + handler 执行，约 1–3 微秒 |

## 7. 业界先例：没人做到「早装」

| 项目 | 机制 | 处理器早于 loader？ | 与本文的关系 |
|---|---|---|---|
| [ssfuisu/cortex](https://github.com/ssfuisu/cortex) | 构建期把 rootfs 里 loader/libc 的 `svc` 改成 `nop`（`set_robust_list`）或 `mov x0,#-38`（`rseq`/`clone3`），匹配不到即构建失败，`libc6` 用 dpkg hold 钉住；运行期另有 `constructor(101)` 装的 handler 与 `sigaction` 守卫 | 否（constructor 晚于 `__libc_early_init`） | 现有 0.10.7 补丁的同构先例；它靠指令层摘掉早期两发，**不试图早装** |
| [Droid-Deck/DroidDeck](https://github.com/Droid-Deck/DroidDeck) | `libddnatv-hook.so` 与 cortex 同源；native 路径同样依赖构建期指令层补丁；默认路径退回打过 28+ 补丁的 proot（ptrace） | 否 | 同上。它的 `0016`（`get_robust_list` 糊 ENOSYS 会让 SteamVR 炸）与 `0027`（带 tag 的 SIGSYS 交回 guest）是重要的反面经验 |
| [termux-pacman/glibc-packages](https://github.com/termux-pacman/glibc-packages) | 源码级 `set-nptl-syscalls.patch` 删掉 `dl-tls_init_tp.c`/`pthread_create.c`/`_Fork.c` 三处调用，并让 `rseq_register_current_thread()` 直接返回 false；`fakesyscall.json` 把 20+ 个被拦调用映射成 ENOSYS 或 0 | 不适用（编译期消除，无 handler） | 证明「表驱动 ENOSYS」可维护；也是「重建 loader/glibc」路线的现成起点 |
| [termux/proot](https://github.com/termux/proot)、Winlator、Mobox、[box64](https://github.com/ptitSeb/box64) | tracer 在 SIGSYS 停点逐调用改寄存器 / 模拟器层逐调用派发 | 进程外，但**按调用计费** | 性能不可接受，已排除（§8） |

AOSP 侧没有可用的放宽通道：

- 最终 app allowlist = `SYSCALLS.TXT` − `SECCOMP_BLOCKLIST_APP.TXT` +
  `SECCOMP_ALLOWLIST_APP.TXT`，只作用于 zygote 派生进程；`Disallow()` 的唯一实现就是
  `SECCOMP_RET_TRAP`。
- `set_robust_list`、`rseq` **从来不在** `SYSCALLS.TXT`（bionic 不调它们），所以这不是
  「某版本才变严」；反过来 `clone3` 反而在 allowlist 里。
- 过滤器唯一安装点是 Zygote 的 `prctl(PR_SET_SECCOMP)`，只能加不能减。

结论：现有世界里最好的是「指令层消除 + 晚装 handler 兜运行期」，最前沿的 cortex 就是这
一套；**把处理器装进 `e_entry` 这一步还没有人做过** —— 这是本方案的增量。

## 8. 已排除的路径

- `LD_PRELOAD` 的 `__attribute__((constructor))`：太晚 —— 两个调用发生在它之前，构造器
  连一行都没跑。
- `LD_PRELOAD` 里的 `ifunc` resolver：也太晚 —— resolver 在所有对象的重定位阶段
  （`elf/rtld.c:2267`）跑，两个调用在 `:1997`。
- `LD_AUDIT` 的 `la_version`：同样晚于 TLS 初始化。
- 覆盖 `__libc_early_init`：它不是调用点，且 ld.so 走 `GLIBC_PRIVATE` 内部引用。
- `SIG_IGN` + exec 继承：同步信号不吃 `SIG_IGN`，exec 还会把已捕获的处理器复位。
- 叠加 `ERRNO`/`USER_NOTIF`/`TRACE` 过滤器：动作优先级 KILL > TRAP > ERRNO >
  USER_NOTIF > TRACE > LOG > ALLOW，继承下来的 TRAP 仍然赢。
- ptrace 监管者：每次被拦两次上下文切换，且要常驻监管进程、逐线程 trace，用户明确排除。
- qemu / box64 翻译层：每次 syscall 都要派发，node 与编译链不可接受。

## 9. 验收计划

离线门禁全部可复现；但「handler 真能改写返回值」这一条只能在真机定生死（§9.4）。

### 9.1 G1 结构门禁（构建期，CI 必须）

```bash
node scripts/inject-sigsys-stub.mjs out/bionilux-loader-aarch64.so   # 第一次改写；第二次打印 already patched 并退出 0
node scripts/inject-sigsys-stub.mjs --verify out/bionilux-loader-aarch64.so
readelf -hW out/bionilux-loader-aarch64.so | grep Entry   # 期望 = cave 地址（2.41-12 为 0x27460）
readelf -lW out/bionilux-loader-aarch64.so                # LOAD#0 的 FileSiz == MemSiz == cave + len（0x274ec）
```

判据：`e_entry` 指向 cave；`LOAD#0` 的 `filesz == memsz`；注入前 cave 整段全零；stub 头部
有魔数与版本；**未知 loader 版本必须失败**（`e_entry`/`LOAD#0`/空隙任一不符即退出非 0，
不静默跳过）；已打过必须幂等。

### 9.2 G2 时序门禁（loader 每次更新，CI 必须）

```bash
qemu-aarch64-static -strace -L rootfs rootfs/usr/bin/true 2>&1 \
  | grep -nE "rt_sigaction|rt_sigprocmask|set_robust_list|Unknown syscall 293" | head
```

判据：第一条 guest 系统调用就是 `rt_sigaction(SIGSYS, ...) = 0`；它（以及正式版加的
`rt_sigprocmask(SIG_UNBLOCK, ...)`）的行号**小于** `set_robust_list` 与 `rseq` 的行号；
最后出现 `exit_group(0)`。原型实测：注入后第一条就是 `rt_sigaction`，早于 `set_robust_list`
（原型还没有解屏蔽那一步，正式版会多一条，判据同时覆盖两条）。

### 9.3 G3 负控（证明门禁本身有效）

```bash
qemu-aarch64-static -L t0 ./sigtest_asm ; echo $?    # 未注入的 loader + 自投 SIGSYS：期望 159
qemu-aarch64-static -L t2 ./sigtest_asm ; echo $?    # 注入的 loader：期望 handler 生效
```

（`t0` 是未注入 loader 的 rootfs，`t2` 是注入后的同一套 rootfs；`sigtest_asm` 是自投 SIGSYS
的测试程序。）

本地**必过项只有第一行**（未注入必须仍是 159）。第二行在本机 qemu 上目前失败，原因见下，
正向判据挪到 G4。

### 9.4 qemu 8.2 的缺陷：端到端只能真机定生死

用注入过 stub 的 loader 跑一个纯汇编 PIE、自己投 `SIGSYS` 的测试程序，qemu 报 `SIGILL`
（`si_addr` 落在注入页附近）。但同一份代码换成静态二进制、或由程序自己装处理器，都正常。
所以判为 **qemu-user 8.2 对「handler 位于 interpreter 映射里 + 同步投递 SIGSYS」的帧/
返回处理缺陷**，不是设计问题。

结论：离线只能证明「stub 真的先进去了、真的早于那两个调用」；**「handler 真能接住并改写
返回值」必须由真机 G4 证明**。不能因为离线不通或通就下结论。

### 9.5 G4 真机门禁（唯一能定生死的）

设备：arm64 真机（vivo V2425A，targetSdk 34 的应用域）。release 包不可调试（`run-as`
不可用），证据靠界面文本、logcat 与程序自身输出。

1. **基础链**：`/usr/bin/true`、`dpkg-divert --listpackage`、`git --version`、
   `node -e ...` 全部正常退出 —— 证明加了 stub 之后没有把本来能跑的弄坏。
2. **通用性反证**：`unshare -U true`、`keyctl show`、
   `python3 -c 'import os; os.setgroups([])'`、`ipcmk`。判据：**都不再以 159 结束**，
   而是普通 errno（`ENOSYS`/`EPERM`）——`setgroups` 在假 root 下会被预载库直接合成成功 0，
   同样算通过；唯一不允许的是 `Bad system call`。这几个程序覆盖的路径不止一个系统调用，
   重点看「没有 SIGSYS」这一条，而不是某个具体 errno。
3. **线程**：`node -e` 起多个 `worker_threads` worker 加并发负载，无 SIGSYS、无异常退出、
   worker 正常回消息。
4. **稳态零开销**：`dd if=/dev/zero of=/dev/null bs=64k count=20000` 与一个百万级小
   syscall 循环，分别在「带 stub」与「不带 stub」的两份 loader 上交替跑多轮取中位数，
   差异应 <2%（噪声内）。
5. **两条防线独立**：临时把 handler 改成「只接管、不改 x0」再跑基础链 —— 已知 5 点已被
   指令层消除，应当**一次 SIGSYS 都不出现**。这一步证明两条防线不是靠同一条路径蒙对的，
   也是「将来能不能删掉指令层补丁」的依据来源。

## 10. 风险与已知限制

- **静态程序不受保护**：没有 loader，stub 不存在，预载库也不在。Go/Rust 静态二进制、
  静态链接的 busybox 之类依旧可能 159。cortex 的做法是「运行前就地 patch 文件」，本方案
  不含；需要时另立一条。
- **guest 自己装处理器 / 屏蔽 SIGSYS 会破坏兜底**：靠预载库守卫拦，但守卫本身也能被绕过
  （静态程序、raw `rt_sigaction`）。这是「生在进程内」的代价。
- **loader 换版本必须重钉断言**：Debian glibc 升版（2.41-12 → 下一次）就要重新核对
  `e_entry`、`LOAD#0` 与空隙。设计上宁可不打也不静默：匹配不到就构建失败。
- **合规面**：改的是 Debian 的 ld.so 二进制，属 LGPL-2.1+ 面。与现状同性质（现在已经在
  分发改过的 loader），不新增义务，但「提供源码/可重链接」这条要保持；建议发布流程复核
  一次。
- **robust mutex 的 owner-death 恢复能力被放弃**：指令层把 `set_robust_list` 改成
  `-ENOSYS` 后 glibc 静默降级（不报错，只是不登记）。实际有意义的场景是**跨进程共享**
  的 robust 互斥 —— 一方进程崩掉，另一方不再能拿到 `EOWNERDEAD` 接管；同进程内的线程
  异常死亡通常连进程一起走。真有人依赖时按 DroidDeck `0016` 做「语义保留」（让
  `get_robust_list` 能真回答），**不要**做恢复模拟（用户态没有线程死亡的可靠通知，被
  `SIGKILL` 打死的线程永远补不上，投入产出不成立）。
- **`rseq` 只是优化**：关掉不影响正确性（`_rseq_size = 0`、`cpu_id` 标记失败），但它是
  glibc 的默认路径，别指望它消失。
- **端到端未验**：stub 装的 handler 能接住真 SIGSYS 目前只有间接证据（信号帧偏移、
  pc 语义、自装 handler 三点都实测过），必须 G4 才能算结论。
- **注入的脆弱性**：依赖「cave 全零」与固定的段布局；由 G1 断言兜住，但这也意味着每次
  loader 换版都要人工核对一遍。

## 11. 决策记录

### 11.1 为什么不上 ptrace

逐调用计费：每次被拦两次上下文切换（约 5–15 微秒），而这层要跑 node / git / 整条编译链；
还要常驻监管进程、多线程逐线程 trace，并且会抢走 guest 自己的 SIGSYS 停点。用户已明确
排除。它在「不需要常驻、调用量小」的场景是好方案，不是这里。

### 11.2 为什么保留指令层补丁，而不是只靠 stub

三个理由，按硬度排序：①建线程路径里信号被 block，TRAP 致命，stub 的 handler 原理上救不了
（§3.2，实测 159）；②指令层是零成本的，删了只会多两次信号交付；③stub 的处理器可能被
guest 覆盖（守卫是补丁，不是保证）。所以关系是**分工**而不是**替代**。

### 11.3 为什么 `set*id` 返回 0 而不是 ENOSYS

因为预载库在假 root 下本来就把 `set*id` 合成成功（apt 的降权从这里走）。如果 handler 改答
ENOSYS，同一个程序的行为会按调用路径分叉：走 libc 包装成功、走 `syscall()` 或内联 `svc`
失败 —— 那是最难查的一类 bug。合成 0 与「假装已经是 root，所以不需要真的切换」是同一件
事，两边必须一致。

### 11.4 为什么 `rseq` 的 `GLIBC_TUNABLES` 只作叠加

`GLIBC_TUNABLES=glibc.pthread.rseq=0` 实测能把这个调用清零（含 loader 自己那次），但它靠
环境变量传递：`env -i`、程序自己 `clearenv`、`AT_SECURE` 场景都会丢。补丁不依赖环境，所以
tunable 只能当「补丁漏了」的第二道保险，不能拿它替代补丁。

## 附：事实来源与复现入口

正文的结论与数字都内联了，不依赖仓外文件；需要追溯原始记录时看这些：

- 调研主报告（仓外）：`_dsh-wt/_sigalts/REPORT.md` —— TL;DR、事实基座、排序表、实施
  草图、验证计划、被证伪的候选。
- 源码行号（仓外）：`_dsh-wt/_sigalts/glibc-source.md` —— glibc 2.41 与 Linux v6.12 的
  逐行位置（含 `elf/rtld.c`、`dl-tls_init_tp.c`、`pthread_create.c`、aarch64 信号帧）。
- 业界先例（仓外）：`_dsh-wt/_sigalts/prior-art.md`、`prior-art-2.md` —— 每条带 URL。
- 原型与实验脚本（仓外）：`_dsh-wt/_sigalts/exp/` 里的 `patch_loader.py`（3 字段注入）、
  `stub_arm64.S`（140 B 原型）、`uctx_arm64.c`（帧偏移与 pc 语义）、`blocked.c`（信号被
  block 时 TRAP 致命）、`sigtest.S`（自投 SIGSYS）。
- 代码位置：`dsh-bionilux/scripts/patch-android-glibc.mjs`、
  `dsh-bionilux/packages/linux-runtime/modules/libc-seccomp-patch.js`、
  `dsh-bionilux/src/preload/hooks.c`（假 root 与 `set*id` 合成）、
  `dsh-bionilux/src/preload/compat_syscall.inc.c`（`syscall()` 的 5 个路径号改写）。
- 本仓历史文档：
  [2026-11-16-linux-env-seccomp-sigsys.md](2026-11-16-linux-env-seccomp-sigsys.md)、
  [2026-11-16-linux-env-arm64-handoff.md](2026-11-16-linux-env-arm64-handoff.md)。
