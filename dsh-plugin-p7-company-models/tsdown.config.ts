import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { client: 'src/client/index.ts' }, tsconfig: 'tsconfig.client.json', outDir: 'lib',
  format: 'cjs', platform: 'browser', target: 'es2022', fixedExtension: false, dts: false, clean: false,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-locale/client', '@deepseek-ai/dsh-client-ui-settings/client', '@deepseek-ai/dsh-client-ui-renderer/client', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-p7-company-models", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' },
})
