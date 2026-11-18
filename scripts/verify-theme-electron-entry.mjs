/** Explicit native test launcher; never opens the operator's existing profile. */
import { app } from 'electron'
import { mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const userData = new URL('../.omx/theme-validation-20261021/electron-user-data/', import.meta.url)
const { fileURLToPath } = await import('node:url')
const isolated = fileURLToPath(userData)
mkdirSync(isolated, { recursive: true })
const resources = join(isolated, 'resources')
mkdirSync(join(resources, 'app'), { recursive: true })
copyFileSync(new URL('../dsh-plugin-desktop-beta/package.json', import.meta.url), join(resources, 'app', 'package.json'))
Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
app.setPath('userData', isolated)
app.setPath('sessionData', join(isolated, 'session'))
app.on('window-all-closed', event => { event.preventDefault() })
void app.whenReady().then(async () => {
  process.env.DSH_VERIFY_THEME_PLUGINS = '1'
  process.env.DSH_VERIFY_THEME_ELECTRON = '1'
  await import('../dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs')
  app.exit(0)
}).catch(error => { console.error(error.stack ?? error); app.exit(1) })
