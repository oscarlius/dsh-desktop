import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DESKTOP_INSTALLER_QUIT_FLAG } from '../src/desktop-installer-quit.ts'

describe('Windows NSIS running-app handoff', () => {
  it('checks for the exact app before requesting orderly shutdown', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const firstDetection = script.indexOf('!insertmacro FIND_PROCESS')
    const request = script.indexOf(DESKTOP_INSTALLER_QUIT_FLAG)
    const wait = script.indexOf('dsh_installer_wait_for_exit:')
    const fallback = script.indexOf('dsh_installer_scoped_fallback:')

    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).toContain('Var pid')
    expect(script).toContain('ExecWait')
    expect(script).toContain('$INSTDIR\\${APP_EXECUTABLE_FILENAME}')
    expect(script).toContain('!insertmacro IS_POWERSHELL_AVAILABLE')
    expect(firstDetection).toBeGreaterThanOrEqual(0)
    expect(request).toBeGreaterThan(firstDetection)
    expect(wait).toBeGreaterThan(request)
    expect(fallback).toBeGreaterThan(wait)
  })

  it('waits for graceful disposal before using the scoped builder fallback', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('$R1 < 60')
    expect(script).toContain('Sleep 500')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1')
    expect(script).not.toContain('taskkill')
    expect(script).not.toContain('nsProcess::KillProcess')
    expect(script).not.toContain('getProcessInfo.nsh')
  })

  it('skips wizard pages during --updated and auto-relaunches when --force-run completes visibly', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('!macro customInit')
    expect(script).toContain('SetSilent normal')
    expect(script).toContain('ShowWindow $HWNDPARENT ${SW_SHOW}')
    expect(script).toContain('BringToFront')
    expect(script).toContain('!macro customInstallMode')
    expect(script).toContain('StrCpy $isForceMachineInstall "1"')
    expect(script).toContain('StrCpy $isForceCurrentInstall "1"')
    expect(script).toContain('!macro customInstall')
    expect(script).toContain('${StdUtils.ExecShellAsUser} $0 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "open" "--updated"')
    expect(script).not.toContain('${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"')
    expect(script).toContain('ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(script).toContain('ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(script).toContain('!insertmacro GetDParameter $R0')
    expect(script).toContain('!macro customPageAfterChangeDir')
    expect(script).toContain('!ifdef allowToChangeInstallationDirectory')
    expect(script).toContain('!undef MUI_PAGE_CUSTOMFUNCTION_PRE')
    expect(script).toContain('!define MUI_PAGE_CUSTOMFUNCTION_PRE dshLegacyInstallPathPre')
    expect(script).toContain('Function dshLegacyInstallPathPre')
    expect(script).toContain('Call instFilesPre')
    expect(script).toContain('!macro normalizeInstallDirectory path')
    expect(script).toContain('!insertmacro normalizeInstallDirectory $R0')
    expect(script).toContain('StrCpy ${path} ${path} -1')
    expect(script).toContain('StrCpy ${path} ${path} "" 1')
    expect(script).toContain('${if} $R0 != ""')
    expect(script).toContain('StrCpy $INSTDIR $R0')
    expect(script).toContain('${if} $installMode == "all"')
    expect(script.indexOf('!macro customPageAfterChangeDir')).toBeGreaterThan(script.indexOf('!macro customInstallMode'))
    expect(script).toContain('DetailPrint "Restarting updated application: $0"')
    expect(script).toContain('${if} $0 == "ok"')
    expect(script).toContain('${orIf} $0 == "fallback"')
    expect(script).toContain('ShowWindow $HWNDPARENT ${SW_SHOWNORMAL}')
    expect(script).toContain('could not be reopened. Please open it from its installation folder.')
    expect(script).toContain('!insertmacro quitSuccess')
  })
})

describe('Windows assisted installer messages', () => {
  it('sets a clearer message for the slow install stage', () => {
    const messages = parse(readFileSync(join(process.cwd(), 'build', 'assistedMessages.yml'), 'utf8')) as {
      installing?: Record<string, string>
    }

    expect(messages.installing?.zh_CN).toBe('DSH Desktop 正在安装，可能需要几分钟；请保持此窗口打开。')
    expect(messages.installing?.en).toContain('This may take several minutes')
  })
})
