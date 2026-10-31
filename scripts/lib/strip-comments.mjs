/**
 * 注释剥离：把源码里的注释内容抹成空格，返回**与原文等长**的掩码文本。
 *
 * 为什么需要共享实现（issue #1191 #1195 #1192 同族）
 * ------------------------------------------------
 * 门禁判据若直接在**原文**上做「文本在场」匹配，注释里的文字就会被当成代码。
 * 本仓踩过两种相反的坑：
 *   假绿：只剩文档头的脚本仍满足「用 /proc/net/tcp 判定」（#1196）；
 *   假红：行尾注释里写一句撤销说明被判成「仍在调用」（#1195）。
 *
 * 更早还踩过第三种：`codeOnly()` 用 `/^\s*(\/\/|#|\*)/` 整行丢弃，
 * 于是「以 // 开头的行」被整行删掉——包括那些行里真正的代码（假绿）。
 *
 * 为什么不用正则一把梭
 * --------------------
 * `//` 会出现在字符串里（`"https://github.com/"` 就含 `//`），
 * 必须先按引号状态走一遍状态机，只在**代码态**里认注释起始。
 * 这正是 issue #1054 修过的形态，抽到这里让四条判据共用同一份实现，
 * 避免各自复制一份再各自漂移。
 *
 * 支持的语言形态：C 系（双斜杠行注释、斜杠星块注释）与 PowerShell（井号行注释、尖括号井号块注释）。
 * 由调用方按目标文件类型选 mode。
 *
 * @param {string} text 源码
 * @param {{ mode?: 'c' | 'powershell' }} [opts] 语言形态，默认 'c'
 * @returns {string} 与原文等长的掩码文本（注释抹成空格，换行保留）
 */
export function stripComments(text, opts = {}) {
  const mode = opts.mode ?? 'c'
  const DQ = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)
  const BT = String.fromCharCode(96)
  const HASH = String.fromCharCode(35)
  const out = text.split('')
  const n = text.length
  const blank = (j) => { if (j < n && text[j] !== '\n' && text[j] !== '\r') out[j] = ' ' }
  const blankRange = (from, to) => { for (let j = from; j < to; j += 1) blank(j) }
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    // PowerShell 块注释 <# ... #>
    if (mode === 'powershell' && c === '<' && next === HASH) {
      let j = i + 2
      while (j < n && !(text[j] === HASH && text[j + 1] === '>')) j += 1
      blankRange(i, Math.min(j + 2, n))
      i = j + 2
      continue
    }
    // PowerShell 行注释 #
    if (mode === 'powershell' && c === HASH) {
      let j = i
      while (j < n && text[j] !== '\n') { blank(j); j += 1 }
      i = j
      continue
    }
    // C 系行注释 //
    if (c === '/' && next === '/') {
      let j = i
      while (j < n && text[j] !== '\n') { blank(j); j += 1 }
      i = j
      continue
    }
    // C 系块注释 /* */
    if (c === '/' && next === '*') {
      let j = i
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) { blank(j); j += 1 }
      blank(j);
      blank(j + 1);
      i = j + 2
      continue
    }
    // 字符串/字符字面量整体跳过（内部可能含 // 或 /* 或 #）
    if (c === DQ || c === SQ || c === BT) {
      let j = i + 1
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j += 1
        j += 1
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * 便捷包装：剥注释后按行过滤掉空行，用于「代码面」匹配。
 *
 * 注意：**不要**按「行首是注释符号」整行丢弃 —— 那会把 `// 说明` 后面的真代码一起删掉
 * （#1195 的姊妹坑）。本函数只依赖 stripComments 的掩码结果，不自己做行级判断。
 *
 * @param {string} text 源码
 * @param {{ mode?: 'c' | 'powershell' }} [opts]
 * @returns {string} 代码面文本（注释已抹空）
 */
export function codeOnly(text, opts = {}) {
  return stripComments(text, opts)
}