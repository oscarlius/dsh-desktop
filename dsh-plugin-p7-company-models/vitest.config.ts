import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
const local = createRequire(import.meta.url)
const desktop = createRequire(new URL('../dsh-plugin-desktop-beta/package.json', import.meta.url))
// Exercise the actual shipped SDK menu and its Desktop dependency graph with
// the same React instance as the company component, not mocked menu behavior.
export default defineConfig({ resolve: { alias: [
  { find: /^react$/, replacement: local.resolve('react') },
  { find: /^react-dom$/, replacement: local.resolve('react-dom') },
  { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: desktop.resolve('@deepseek-ai/dsh-client-ui-primitives') },
] }, test: { environment: 'node', include: ['tests/**/*.spec.{ts,tsx}'],
  server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
} })
