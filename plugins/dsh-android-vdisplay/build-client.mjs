#!/usr/bin/env node
/**
 * build-client.mjs — 浏览器端 bundle（ModuleLoader 闭包工厂格式），与
 * plugins/dsh-android-bridge/build-client.mjs、dsh-client-ui-responsive/build-scripts/tsdown.client.ts
 * 同一产物契约：window.__ModuleLoader__.load({ id, factory: (require) => { ... } })。
 * 平台模块（react / jsx-runtime / cordis / ui-slots / 客户端运行时）留在 require() 之外，由 loader 模块表解析。
 */
import { build } from 'esbuild'

const ID = '@dsh-android/dsh-android-vdisplay'

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]
const RUNTIME_FACES = ['@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-runtime']

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: 'lib/client.js',
  sourcemap: true,
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  external: [...PLATFORM_MODULES, ...RUNTIME_FACES],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})
console.log('client bundle written: lib/client.js')
