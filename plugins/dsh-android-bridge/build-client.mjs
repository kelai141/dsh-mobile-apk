#!/usr/bin/env node
/**
 * build-client.mjs — 浏览器端 bundle（ModuleLoader 闭包工厂格式）。
 *
 * 与 dsh-client-ui-responsive/build-scripts/tsdown.client.ts 同一产物契约：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } });
 * 平台模块（react/jsx-runtime 等）留在 require() 之外，由 loader 模块表解析；
 * 其余包（本插件无第三方运行时依赖）全部内联。
 * TS 由 tsc（tsconfig.client.json 仅类型检查）+ esbuild 转译承担。
 */
import { build } from 'esbuild'

const ID = '@dsh-android/dsh-android-bridge'

// 平台模块（共享模块表；与 dsh-client-ui-responsive/build-scripts/platform.ts 对齐）
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]
// 客户端运行时类型面（仅本插件 apply 的宿主模块；类型导入在编译期擦除，列在此以防被误内联）
const RUNTIME_FACES = ['@deepseek-ai/dsh-client-runtime/client']

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: 'lib/client.js',
  sourcemap: true,
  target: 'es2022',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  external: [...PLATFORM_MODULES, ...RUNTIME_FACES],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})
console.log('client bundle written: lib/client.js')
