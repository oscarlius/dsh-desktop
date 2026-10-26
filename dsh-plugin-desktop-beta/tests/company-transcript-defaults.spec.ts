import { expect, it } from 'vitest'
import {
  COMPANY_TRANSCRIPT_DEFAULTS,
  COMPANY_TRANSCRIPT_SETTINGS_KEY,
  companyTranscriptDefaultsScript,
  installCompanyTranscriptDefaults,
} from '../src/client/company-transcript-defaults.ts'

function storageWith(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

it('seeds the company StreamFold defaults only when no preference exists', () => {
  const storage = storageWith()

  expect(installCompanyTranscriptDefaults(storage)).toBe(true)
  expect(JSON.parse(storage.values.get(COMPANY_TRANSCRIPT_SETTINGS_KEY)!)).toEqual(COMPANY_TRANSCRIPT_DEFAULTS)
  expect(installCompanyTranscriptDefaults(storage)).toBe(false)
})

it('preserves every existing StreamFold preference without parsing or rewriting it', () => {
  const existing = '{not valid json'
  const storage = storageWith({ [COMPANY_TRANSCRIPT_SETTINGS_KEY]: existing })

  expect(installCompanyTranscriptDefaults(storage)).toBe(false)
  expect(storage.values.get(COMPANY_TRANSCRIPT_SETTINGS_KEY)).toBe(existing)
})

it('does nothing outside a renderer storage environment', () => {
  expect(installCompanyTranscriptDefaults(undefined)).toBe(false)
})

it('emits a first-frame script that seeds before StreamFold reads storage', () => {
  const storage = storageWith()
  const execute = new Function('localStorage', companyTranscriptDefaultsScript())
  execute(storage)
  expect(JSON.parse(storage.values.get(COMPANY_TRANSCRIPT_SETTINGS_KEY)!)).toEqual(COMPANY_TRANSCRIPT_DEFAULTS)
  storage.values.set(COMPANY_TRANSCRIPT_SETTINGS_KEY, '{"windowHeight":360}')
  execute(storage)
  expect(storage.values.get(COMPANY_TRANSCRIPT_SETTINGS_KEY)).toBe('{"windowHeight":360}')
})
