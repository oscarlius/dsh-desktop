/** Verify the P7 settings section in the real composed Desktop client. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_ORIGIN = 'https://maas.zxrc.com.cn:8090'

function response(status) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(status) }
}

async function selectP7Settings(page) {
  const settingsName = /^(settings|设置)$/iu
  const directSettings = page.getByRole('button', { name: settingsName })
  if (await directSettings.count()) {
    await directSettings.first().click()
  } else {
    const more = page.getByRole('button', { name: /^(more|更多|menu|菜单|account menu|账号菜单)$/iu })
    if (await more.count()) {
      await more.first().click()
      assert.equal(await page.getByRole('menuitem', { name: /^(sign in|登录|登录 DeepSeek)$/iu }).count(), 0,
        'company builds must not expose a DeepSeek sign-in menu entry')
    }

    const menuSettings = page.getByRole('menuitem', { name: settingsName })
    if (await menuSettings.count()) await menuSettings.first().click()
    else await page.locator('button, a').filter({ hasText: settingsName }).last().click()
  }
  const section = page.getByText(/^(P7 Company Models|P7 公司模型)$/u)
  await section.first().click()
  await page.locator('.dshP7CompanySettings').waitFor()
}

async function dismissReleaseNotice(page) {
  const releaseNotice = page.getByRole('presentation').filter({ hasText: /Preview release notes|预览版说明/u })
  if (await releaseNotice.count()) {
    await releaseNotice.getByRole('button', { name: /^(Continue|继续)$/u }).click()
    await releaseNotice.waitFor({ state: 'detached' })
  }
}

/**
 * The profile boot smoke supplies the already-authenticated renderer URL and
 * browser cookie. This function owns only P7 route fixtures and UI assertions.
 */
export async function verifyCompanySettingsBrowser({ url, cookie, headers, liveCompanyModels = false, screenshots = process.env.DSH_COMPANY_SCREENSHOTS ?? join(tmpdir(), 'dsh-company-settings') }) {
  const { chromium } = createRequire(new URL('../dsh-desktop-next/package.json', import.meta.url))('playwright')
  mkdirSync(screenshots, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ? { channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL } : {}) })
  let page
  const secret = 'browser-only-p7-key'
  let connected = false
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', extraHTTPHeaders: headers })
    const target = new URL(url)
    for (const key of [...target.searchParams.keys()]) {
      if (key.startsWith('dsh-desktop-')) target.searchParams.delete(key)
    }
    const separator = cookie.indexOf('=')
    await context.addCookies([{ url: target.origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }])
    if (!liveCompanyModels) await context.route('**/p7-company-models/status', route => route.fulfill(response(connected ? {
      phase: 'ready', origin: PUBLIC_ORIGIN, revision: 'browser-fixture', lastSyncedAt: 1_700_000_000_000,
      defaultModel: 'p7-browser', models: [{ id: 'p7-browser', displayName: 'P7 Browser', api: 'openai-responses', contextWindow: 128000, maxOutputTokens: 8192, inputModalities: ['text'] }], message: null,
    } : { phase: 'disconnected', origin: null, revision: null, lastSyncedAt: null, defaultModel: null, models: [], message: null })))
    if (!liveCompanyModels) await context.route('**/p7-company-models/connect', async route => {
      const body = route.request().postDataJSON()
      assert.deepEqual(body, { origin: PUBLIC_ORIGIN, apiKey: secret })
      connected = true
      await route.fulfill(response({
        phase: 'ready', origin: PUBLIC_ORIGIN, revision: 'browser-fixture', lastSyncedAt: 1_700_000_000_000,
        defaultModel: 'p7-browser', models: [{ id: 'p7-browser', displayName: 'P7 Browser', api: 'openai-responses', contextWindow: 128000, maxOutputTokens: 8192, inputModalities: ['text'] }], message: null,
      }))
    })
    page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
    })
    page.setDefaultTimeout(20_000)
    await page.goto(target.href)
    try {
      await dismissReleaseNotice(page)
      assert.equal(await page.getByRole('button', { name: /^(sign in to DeepSeek|登录 DeepSeek)$/iu }).count(), 0,
        'company builds must not expose the DeepSeek sign-in button')
      assert.equal(await page.getByRole('button', { name: /^(sign in|登录)$/iu }).count(), 0,
        'company builds must not expose the manual DeepSeek login action')
      assert.equal(await page.getByRole('dialog', { name: /^(get started|开始使用)$/iu }).count(), 0,
        'company builds must not render the DeepSeek sign-in dialog')
      await selectP7Settings(page)
    } catch (error) {
      const failure = join(screenshots, 'p7-company-settings-failure.png')
      await page.screenshot({ path: failure, fullPage: true })
      const body = await page.locator('body').innerText().catch(() => '')
      const overlays = await page.locator('[role="presentation"]').evaluateAll(nodes => nodes.map(node => ({
        className: node.className,
        text: node.textContent?.slice(0, 500),
      }))).catch(() => [])
      writeFileSync(join(screenshots, 'p7-company-settings-failure.json'), JSON.stringify({
        url: page.url(), body: body.slice(0, 4000), overlays, pageErrors,
      }, null, 2))
      throw new Error(`P7 settings navigation failed; diagnostics: ${failure}`, { cause: error })
    }
    const surface = page.locator('.dshP7CompanySettings')
    await page.screenshot({ path: join(screenshots, 'p7-company-settings-desktop-light.png') })
    assert.equal(await page.locator('#dsh-p7-company-models-settings-styles').count(), 1, 'the CJS bundle must inject its P7 styles')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop P7 settings must not overflow')
    assert.equal(await page.getByLabel('Service URL').count(), 0, 'the default address must not require editing')
    assert.equal(await page.getByText(PUBLIC_ORIGIN, { exact: true }).count(), 1)
    const key = page.getByLabel('API key')
    if (liveCompanyModels) {
      await page.getByText('Qwen3.8-Flash-Next', { exact: true }).first().waitFor()
      assert.equal(await surface.locator('[data-phase="ready"]').count(), 1, 'the live company catalog must be ready')
      assert.equal(await key.count(), 0, 'a ready public company catalog must not expose an API-key input')
      await page.screenshot({ path: join(screenshots, 'live-company-models.png') })
    } else {
      assert.ok(await key.evaluate(element => {
        const input = element.getBoundingClientRect(), field = element.parentElement.getBoundingClientRect()
        return input.width >= field.width - 1 && input.width > 200
      }), 'the key input should occupy its form field width')
      await key.fill(secret)
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      await page.getByText('P7 Browser', { exact: true }).waitFor()
      assert.equal(await page.locator('body').innerText().then(text => text.includes(secret)), false, 'the connect key must not remain visible')
      assert.equal(await page.locator('input').evaluateAll(inputs => inputs.some(input => input.value === 'browser-only-p7-key')), false,
        'the connect key must clear after submit')
      assert.equal(await page.getByText('browser-fixture', { exact: true }).count(), 1)
    }
    await page.setViewportSize({ width: 760, height: 800 })
    await page.emulateMedia({ colorScheme: 'dark' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow P7 settings must not overflow')
    assert.ok(await surface.evaluate(element => getComputedStyle(element).display === 'grid'), 'the scoped P7 styles must be active')
    await page.screenshot({ path: join(screenshots, 'p7-company-settings-narrow-dark.png') })
    assert.deepEqual(pageErrors.filter(message => !message.startsWith('console:') || message.includes('Failed to load plugins')), [],
      'the renderer must not report page errors or plugin-load failures')
  } finally {
    await browser.close()
  }
}

/** Verify the real public company catalog without intercepting its P7 endpoints. */
export function verifyLiveCompanySettingsBrowser(options) {
  return verifyCompanySettingsBrowser({ ...options, liveCompanyModels: true })
}
