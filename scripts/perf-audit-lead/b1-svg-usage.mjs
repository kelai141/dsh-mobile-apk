import { readFileSync } from 'node:fs'
const s = readFileSync(process.argv[2], 'utf8')
const re = /var ([A-Za-z_$][\w$]*) = "data:image\/(webp|svg\+xml);base64,/g
let m; const vars = []
while ((m = re.exec(s)) !== null) vars.push({ name: m[1], mime: m[2], at: m.index })
console.log('命名变量:', vars.length, '个')
for (const v of vars) {
  const uses = []
  let i = s.indexOf(v.name, v.at + 10)
  while (i > 0 && uses.length < 3) {
    uses.push(s.slice(Math.max(0, i - 200), i + 80).replace(/[A-Za-z0-9+/=]{200,}/g, '<<B64>>').replace(/\s+/g, ' '))
    i = s.indexOf(v.name, i + 1)
  }
  console.log('--- ' + v.name + ' (' + v.mime + ') 引用 ' + uses.length + ' 处')
  for (const u of uses) console.log('    ' + u)
}