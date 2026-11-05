// 共享剥离模块的自检（#1191 #1195 #1196 同族的地基）
import { stripComments, codeOnly } from './lib/strip-comments.mjs'
const NL = String.fromCharCode(10);
const DQ = String.fromCharCode(34);
let checks = 0;
let failed = 0;
const ok = (label, cond, detail) => { checks += 1; if (!cond) { failed += 1; console.error('  FAIL ' + label + (detail ? ' -> ' + detail : '')) } else console.log('  ok   ' + label) };

// C 系
const c1 = 'const u = ' + DQ + 'https://github.com/x' + DQ + ' // note';
const s1 = stripComments(c1);
ok('字符串里的 // 不被当注释（URL 保留）', s1.includes('https://github.com/x'));
ok('行尾注释被抹掉', !s1.includes('note'));
ok('等长掩码（行号不变）', s1.length === c1.length);

const c2 = 'run() /* block */ next()';
const s2 = stripComments(c2);
ok('块注释被抹掉', !s2.includes('block'));
ok('块注释两侧代码保留', s2.includes('run()') && s2.includes('next()'));

// 关键回归：整行以 // 开头的真代码不得被整行删除
const c3 = '// looks like comment' + NL + 'const real = 1';
const s3 = stripComments(c3);
ok('后面的真代码存活（不按行首符号整行丢）', s3.includes('const real = 1'));

// PowerShell 系
const p1 = 'Write-Host hi # trailing';
const sp1 = stripComments(p1, { mode: 'powershell' });
ok('PS 行注释被抹掉', !sp1.includes('trailing'));
ok('PS 代码保留', sp1.includes('Write-Host hi'));

const p2 = ['<#', '  doc block with marker -DryRun', '#>', 'Write-Output x'].join(NL);
const sp2 = stripComments(p2, { mode: 'powershell' });
ok('PS 块注释被抹掉', !sp2.includes('-DryRun'));
ok('PS 块注释后的代码保留', sp2.includes('Write-Output x'));

// 反证：不剥注释时 marker 仍在（证明上面的剥离确实起作用，不是文本本来就没有）
ok('反证：未剥离时 marker 仍在', p2.includes('-DryRun'));

// issue #1281：正则字面量（内部引号个数为奇数时会带偏状态机）
const r1 = 'const a = /abc/' + NL + '// MARK-A' + NL + 'const b = 1';
const sr1 = stripComments(r1);
ok('正则字面量之后的注释被剥', !sr1.includes('MARK-A'));
ok('正则字面量本身保留', sr1.includes('/abc/'));

// 真实触发形态：build-apk.mjs 第 52 行那个正则带引号与字符类，奇数错位
const r2 = 'const re = /versionName\\s*=\\s*' + DQ + '([^' + DQ + ']+)' + DQ + '/' + NL + '// MARK-B' + NL + 'const c = 2';
const sr2 = stripComments(r2);
ok('带引号的正则之后的注释被剥（奇数引号不再带偏）', !sr2.includes('MARK-B'));
ok('带引号的正则本身保留', sr2.includes('/versionName'));

// 反向：除号不得被误当成正则起点（否则会吞掉后续代码）
const r3 = 'const half = total / 2' + NL + 'const d = 3';
const sr3 = stripComments(r3);
ok('除号不被误判为正则', sr3.includes('total / 2') && sr3.includes('const d = 3'));

// 反向：未闭合的斜杠不得吞掉整份文件
const r4 = 'const bad = a / b' + NL + 'const e = 4';
const sr4 = stripComments(r4);
ok('未闭合的斜杠不吞后续代码', sr4.includes('const e = 4'));

// codeOnly 与 stripComments 等价（不给调用方两套语义）
ok('codeOnly 与 stripComments 同口径', codeOnly(p1, { mode: 'powershell' }) === sp1);

console.log((failed === 0 ? 'STRIP-COMMENTS SELF-TEST PASSED' : 'STRIP-COMMENTS SELF-TEST FAILED') + '（' + checks + ' 项）');
process.exit(failed === 0 ? 0 : 1);