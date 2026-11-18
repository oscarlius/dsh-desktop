import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// These assertions pin the upstream behaviors dsh-web-host silently relies on.
// When an upstream bump breaks one, update the dependent code in the same commit.
const packages = new URL('../node_modules/@deepseek-ai/', import.meta.url)
const read = (name: string, file: string) => readFileSync(new URL(`${name}/${file}`, packages), 'utf8')

it('keeps the launcher startup-line contract with the official web app', () => {
  expect(read('dsh-web-app', 'lib/index.js')).toContain('dsh web: ${authenticatedUrl}')
})

it('keeps the connection service contract used for cookie renewal', () => {
  const source = read('dsh-client-connection', 'lib/index.js')
  expect(source).toContain('authenticatedUrl(baseUrl)')
  expect(source).toContain('cookieMaxAgeDays')
})

it('keeps the agents service contract used by the activity probe', () => {
  expect(read('dsh-agent', 'lib/index.js')).toContain('super(ctx, "agents")')
})

it('runs against the exact upstream versions declared in this package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
  for (const name of ['dsh-web-app', 'dsh-client-connection', 'dsh-agent']) {
    const installed = JSON.parse(read(name, 'package.json')) as { version: string }
    expect(manifest.dependencies[`@deepseek-ai/${name}`]).toBe(installed.version)
  }
})
