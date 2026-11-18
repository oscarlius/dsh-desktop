/** Real Desktop Electron transport and appearance checks in a disposable profile. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'

/** A bright two-tone PNG makes a missing or covered wallpaper visually obvious. */
export function createThemeFixturePng() {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, bytes, checksum])
  }
  const size = 128, stride = 1 + size * 3, pixels = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const color = x < size / 2 ? [32, 120, 240] : [255, 140, 32]
    for (let c = 0; c < 3; c++) pixels[y * stride + 1 + x * 3 + c] = color[c]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const PNG = createThemeFixturePng()

async function waitFor(check, label) {
  const deadline = Date.now() + 25_000
  do { if (await check()) return; await delay(200) } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

export async function verifyThemeElectron({ ctx, spec, home, profileDir, screenshots }) {
  const { webContents } = await import('electron')
  const { ElectronDesktopRuntime } = await import('../dsh-plugin-desktop-beta/lib/electron-runtime.js')
  const output = join(screenshots, 'electron')
  mkdirSync(output, { recursive: true })
  const imagePath = join(home, 'theme-native-fixture.png')
  writeFileSync(imagePath, PNG)
  const report = { isolated: true, transport: 'actual ElectronDesktopRuntime', cases: [], errors: [], healthReports: [] }
  const manager = ctx.pluginManager
  let dispose
  let runtime
  try {
    for (const selected of ['dsh-any-background', 'beauticode-dsh']) {
      for (const name of ['dsh-any-background', 'beauticode-dsh']) await manager.setBundleEnabled(name, name === selected)
      await delay(350)
      runtime = new ElectronDesktopRuntime(async () => {})
      dispose = runtime.schedule({ ...spec, mode: 'extended', material: 'off',
        readRemoteControl: undefined, enableRemoteControl: undefined })
      await runtime.mountScheduled()
      const renderer = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(new URL(spec.url).origin))
      assert.ok(renderer, 'real Electron renderer was not created')
      renderer.debugger.attach('1.3')
      await renderer.debugger.sendCommand('Network.enable')
      renderer.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.requestWillBeSent' && params.request.url.endsWith('/_dsh/desktop/renderer-boot')) {
          report.healthReports.push({ selected, payload: params.request.postData })
        }
      })
      renderer.on('console-message', event => {
        if ((event.level === 'warning' || event.level === 'error') && /dsh-any|beauticode|failed|error|module table/i.test(event.message)) {
          report.errors.push({ selected, message: event.message })
        }
      })
      await waitFor(() => renderer.executeJavaScript('Boolean(document.querySelector("#root button"))'), 'composed client')
      const before = await renderer.executeJavaScript('({ title:document.title, body:getComputedStyle(document.body).backgroundColor, beauty:document.documentElement.dataset.bcActive??null })')
      let applied
      if (selected === 'dsh-any-background') {
        applied = await renderer.executeJavaScript(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}),c=>c.charCodeAt(0));const response=await fetch('/dsh-any-background/wallpaper/upload',{method:'POST',headers:{'content-type':'image/png'},body:new Blob([bytes],{type:'image/png'})});return {status:response.status,body:await response.text()}})()`)
        assert.equal(applied.status, 200, JSON.stringify(applied))
        renderer.reloadIgnoringCache()
        await waitFor(() => renderer.executeJavaScript('Array.from(document.body.children).some(e=>e.style.backgroundImage.includes("dsh-any-background/wallpaper"))'), 'persisted wallpaper layer')
        assert.equal(await renderer.executeJavaScript('new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth===128&&image.naturalHeight===128);image.onerror=()=>resolve(false);image.src="/dsh-any-background/wallpaper"})'), true, 'persisted PNG must decode in the native renderer')
        report.configSave = await renderer.executeJavaScript(`(async () => {
          let id = 0;
          const rpc = async (name, payload) => {
            const method = 'dshAnyBackground/' + name;
            const response = await fetch('/dsh-any-background/' + method, { method:'POST',
              headers:{'content-type':'application/json'},
              body:JSON.stringify({type:'client-request',rpcId:String(++id),method,payload}) });
            if (!response.ok) throw Error('config RPC HTTP ' + response.status);
            return (await response.json()).result;
          };
          const before = await rpc('read');
          const config = before.value.config;
          const writes = await Promise.all(Array.from({length:32}, (_, index) => rpc('writeConfig', {config:{...config,settingsOpacity:index/32}})));
          const final = await rpc('writeConfig', {config:{...config,settingsOpacity:0.8}});
          const after = await rpc('read');
          return {requests:32,succeeded:writes.filter(row=>row.ok&&row.value===true).length,
            finalSaved:final.ok&&final.value===true&&after.value.config.settingsOpacity===0.8,host:after.value.host};
        })()`)
        assert.equal(report.configSave.succeeded, 32, 'all concurrent config saves must succeed')
        assert.equal(report.configSave.finalSaved, true, 'the final appearance selection must persist')
      } else {
        const { createBeauticodeActions } = await import(pathToFileURL(join(profileDir, 'node_modules/beauticode-dsh/agent.mjs')).href)
        const { resolveApplyBackend } = await import(pathToFileURL(join(profileDir, 'node_modules/beauticode-dsh/host-apply.mjs')).href)
        const options = { dataRoot: join(home, 'beauticode'), baseUrl: new URL(spec.url).origin }
        const backend = await resolveApplyBackend(options)
        await waitFor(() => renderer.executeJavaScript('document.documentElement.dataset.bcGeneration !== undefined'), 'initial beauty renderer receipt')
        await waitFor(() => backend.kind !== 'local' || !backend.session.isBusy, 'background restore to finish')
        const actions = createBeauticodeActions(options)
        applied = await actions.applyImage(imagePath, undefined, { themeName: 'Native isolated verification' })
        assert.equal(applied.ok, true)
        await waitFor(() => renderer.executeJavaScript('document.documentElement.dataset.bcActive==="true"&&Boolean(document.querySelector("#beauticode-bg-stage img")?.naturalWidth)'), 'beautiCode background render')
      }
      const after = await renderer.executeJavaScript('({body:getComputedStyle(document.body).backgroundColor,beauty:document.documentElement.dataset.bcActive??null,layers:Array.from(document.body.children).filter(e=>e.style.backgroundImage).map(e=>({image:e.style.backgroundImage,z:e.style.zIndex}))})')
      writeFileSync(join(output, `${selected}.png`), (await renderer.capturePage()).toPNG())
      report.cases.push({ selected, before, applied, after, success: true })
      if (selected === 'beauticode-dsh') {
        await manager.setBundleEnabled('dsh-any-background', true)
        await waitFor(() => renderer.executeJavaScript('document.documentElement.dataset.bcActive === "true" && Array.from(document.body.children).some(e=>e.style.backgroundImage.includes("dsh-any-background/wallpaper"))'), 'both installed background layers')
        report.coexistence = await renderer.executeJavaScript(`new Promise(resolve => {
          let mutations = 0;
          const observer = new MutationObserver(records => { mutations += records.length });
          observer.observe(document.documentElement, { attributes:true });
          observer.observe(document.body, { attributes:true });
          setTimeout(() => { observer.disconnect(); resolve({ bothBackgroundsActive:true, mutationsInTwoSeconds:mutations }) }, 2000);
        })`)
        writeFileSync(join(output, 'both-plugins.png'), (await renderer.capturePage()).toPNG())
      }
      runtime.prepareToQuit()
      await dispose(); dispose = undefined
    }
  } catch (error) {
    report.failure = error.stack ?? String(error)
    throw error
  } finally {
    runtime?.prepareToQuit()
    await dispose?.()
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  }
}
