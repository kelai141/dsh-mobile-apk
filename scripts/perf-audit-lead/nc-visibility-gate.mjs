// #4 负控：证明「后台不排下一拍」真的可分辨。
//
// 判据口径（与仓库既有参照实现 native-browser-auto-place.ts:87-101 一致）：
//   首次 schedule() 无条件排一拍（挂载即对齐一次是期望行为），
//   之后每一拍结束时才由 document.hidden 决定「排不排下一拍」。
// 所以后台的期望是 **恰好 1 拍**（首拍），而不是 0；改动前的裸 setInterval 会持续跑。
const run = (hidden, shape) => {
  let ticks = 0
  let id = null
  const doc = { hidden }
  const schedule = () => {
    if (id !== null) return
    id = setTimeout(() => {
      id = null
      ticks++
      if (shape === 'gated') { if (!doc.hidden) schedule() } else { schedule() }
    }, 1)
  }
  if (shape === 'gated') schedule()
  else id = setInterval(() => { ticks++ }, 1)
  return new Promise((res) => setTimeout(() => { try { clearTimeout(id); clearInterval(id) } catch {} res(ticks) }, 60))
}
const main = async () => {
  const gatedHidden = await run(true, 'gated')
  const gatedVisible = await run(false, 'gated')
  const legacyHidden = await run(true, 'legacy')
  console.log('shape=gated  hidden=true  ticks =', gatedHidden, ' (期望 =1：只有首拍，之后不排)')
  console.log('shape=gated  hidden=false ticks =', gatedVisible, ' (期望 >1：前台持续自续)')
  console.log('shape=legacy hidden=true  ticks =', legacyHidden, ' (改动前裸 setInterval，期望 >>1)')
  const ok = gatedHidden === 1 && gatedVisible > 1 && legacyHidden > gatedHidden * 3
  console.log('')
  console.log('后台拍数降幅: ' + legacyHidden + ' -> ' + gatedHidden
    + '  (约 -' + (100 * (legacyHidden - gatedHidden) / legacyHidden).toFixed(0) + '%)')
  console.log(ok ? 'NEGATIVE-CONTROL PASSED：门生效且前后可分辨' : 'NEGATIVE-CONTROL FAILED')
  process.exit(ok ? 0 : 1)
}
main()
