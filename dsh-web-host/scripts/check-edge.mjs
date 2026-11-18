#!/usr/bin/env node
/**
 * Edge contract check for a deployed DSH Web edge. Every probe is
 * unauthenticated; a pass means the edge keeps the container contract
 * (session gate, no internal routes, no core-cookie leakage).
 *
 *   node scripts/check-edge.mjs https://<edge>/dsh/
 */
const argument = process.argv[2]
if (!argument) { console.error('usage: node scripts/check-edge.mjs https://<edge>/dsh/'); process.exit(2) }
const base = new URL(argument)
if (base.protocol !== 'https:') { console.error('the edge URL must be HTTPS'); process.exit(2) }
if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`

const results = []
const expect = (condition, message) => { if (!condition) throw new Error(message) }
const expectNoCoreCookie = response => { for (const header of response.headers.getSetCookie()) expect(!header.startsWith('dsh-auth-'), `core cookie leaked to the browser: ${header.split(';', 1)[0]}`) }
const check = async (name, run) => { try { await run(); results.push(['PASS', name]) } catch (error) { results.push(['FAIL', `${name}: ${error instanceof Error ? error.message : String(error)}`]) } }

await check('session gate rejects anonymous browsers', async () => {
  const response = await fetch(base, { redirect: 'manual' })
  expect(response.status !== 200, `anonymous index request returned ${response.status}`)
  expectNoCoreCookie(response)
})

for (const route of ['activity', 'ready', 'bootstrap']) {
  await check(`internal route p7-web-host/internal/${route} is never proxied`, async () => {
    const response = await fetch(new URL(`p7-web-host/internal/${route}`, base), { redirect: 'manual' })
    expect(response.status !== 200, `internal route returned ${response.status}`)
  })
}

await check('forged attestation headers are not honored', async () => {
  const response = await fetch(base, {
    redirect: 'manual',
    headers: {
      'x-p7-web-employee': 'forged', 'x-p7-web-instance': 'forged', 'x-p7-web-generation': '0',
      'x-p7-web-expires': String(Date.now() + 30_000), 'x-p7-web-signature': 'Zm9yZ2Vk',
    },
  })
  expect(response.status !== 200, `forged attestation returned ${response.status}`)
  expectNoCoreCookie(response)
})

let failed = 0
for (const [status, name] of results) { console.log(`${status} ${name}`); if (status !== 'PASS') failed++ }
process.exit(failed === 0 ? 0 : 1)
