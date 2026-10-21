/** Browser UI checks against isolated appearance bundles. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createThemeFixturePng } from './verify-theme-electron.mjs'

async function settings(page) {
  await page.getByRole('button', { name: /^(more|更多|account menu|账号菜单)$/iu }).first().click()
  await page.getByRole('menuitem', { name: /^(settings|设置)$/iu }).click()
}

export async function verifyThemePluginsBrowser({ url, cookie, headers, ctx, home, profileDir, screenshots }) {
  mkdirSync(screenshots, { recursive: true })
  const { chromium } = createRequire(new URL('../dsh-desktop-next/package.json', import.meta.url))('playwright')
  const browser = await chromium.launch({ headless: true, channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ?? 'chrome' })
  const imagePath = join(home, 'theme-browser-fixture.png')
  writeFileSync(imagePath, createThemeFixturePng())
  const report = { isolated: true, cases: [], events: [] }
  let page
  try {
    for (const selected of ['dsh-any-background', 'beauticode-dsh']) {
      for (const name of ['dsh-any-background', 'beauticode-dsh']) await ctx.pluginManager.setBundleEnabled(name, name === selected)
      const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, extraHTTPHeaders: headers })
      const separator = cookie.indexOf('=')
      await context.addCookies([{ url: new URL(url).origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }])
      page = await context.newPage()
      page.setDefaultTimeout(20_000)
      page.on('pageerror', error => report.events.push({ selected, type: 'pageerror', message: error.message }))
      page.on('console', message => { if (message.type() === 'error') report.events.push({ selected, type: 'console', message: message.text() }) })
      page.on('response', response => {
        if (response.status() >= 400) report.events.push({ selected, type: 'response', status: response.status(), path: new URL(response.url()).pathname })
      })
      // Keep native renderer markers together with the fixture's capability.
      await page.goto(url)
      const notice = page.getByRole('presentation').filter({ hasText: /Preview release notes|预览版说明/u })
      if (await notice.count()) await notice.getByRole('button', { name: /^(Continue|继续)$/u }).click()
      await page.getByRole('button', { name: /^(more|更多|account menu|账号菜单)$/iu }).first().waitFor()
      const signIn = page.getByRole('presentation').filter({ has: page.getByRole('heading', { name: /^(Get started|开始使用)$/iu }) })
      await signIn.waitFor({ timeout: 3000 }).catch(() => {})
      if (await signIn.count()) await signIn.getByRole('button', { name: /^(close|关闭)$/iu }).click()
      await settings(page)
      let applied
      if (selected === 'dsh-any-background') {
        await page.getByRole('button', { name: /^(Theme|主题)$/iu }).click()
        await page.getByText(/^(Background|背景)$/iu).first().click()
        await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(imagePath)
        await page.waitForFunction(() => Array.from(document.body.children).some(node => node.style.backgroundImage.includes('dsh-any-background/wallpaper')))
        applied = { persisted: true, filePickerInput: true }
      } else {
        await page.locator('[data-bc-nav="console"]').click()
        const { createBeauticodeActions } = await import(pathToFileURL(join(profileDir, 'node_modules/beauticode-dsh/agent.mjs')).href)
        const { resolveApplyBackend } = await import(pathToFileURL(join(profileDir, 'node_modules/beauticode-dsh/host-apply.mjs')).href)
        const backend = await resolveApplyBackend({ dataRoot: join(home, 'beauticode'), baseUrl: new URL(url).origin })
        await page.waitForFunction(() => document.documentElement.dataset.bcGeneration !== undefined)
        const deadline = Date.now() + 20_000
        while (backend.kind === 'local' && backend.session.isBusy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
        assert.ok(backend.kind !== 'local' || !backend.session.isBusy, 'initial background restore must finish')
        applied = await createBeauticodeActions({ dataRoot: join(home, 'beauticode'), baseUrl: new URL(url).origin })
          .applyImage(imagePath, undefined, { themeName: 'Browser isolated verification' })
        assert.equal(applied.ok, true)
        await page.waitForFunction(() => document.documentElement.dataset.bcActive === 'true' && document.querySelector('#beauticode-bg-stage img')?.naturalWidth > 0)
      }
      await page.screenshot({ path: join(screenshots, selected + '-applied.png') })
      await page.reload()
      await page.waitForFunction(name => name === 'beauticode-dsh'
        ? document.documentElement.dataset.bcActive === 'true'
        : Array.from(document.body.children).some(node => node.style.backgroundImage.includes('dsh-any-background/wallpaper')), selected)
      const state = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor,
        beauty: document.documentElement.dataset.bcActive ?? null, dialogs: document.querySelectorAll('[role="dialog"]').length }))
      await page.screenshot({ path: join(screenshots, selected + '-reloaded.png') })
      report.cases.push({ selected, applied, state, reloadPreserved: true })
      assert.deepEqual(report.events.filter(event => event.selected === selected && event.type === 'pageerror'), [])
      await context.close(); page = undefined
    }
  } catch (error) {
    report.failure = error.stack ?? String(error)
    if (page) {
      report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000)
      await page.screenshot({ path: join(screenshots, 'theme-browser-failure.png') }).catch(() => {})
    }
    throw error
  } finally {
    writeFileSync(join(screenshots, 'theme-browser-report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
}
