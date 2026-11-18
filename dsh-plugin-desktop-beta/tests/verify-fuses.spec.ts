import { expect, it } from 'vitest'
import { finalArtifactExecutablePaths } from '../scripts/verify-fuses.ts'

it('derives final artifact executable paths from the package product name', () => {
  expect(finalArtifactExecutablePaths('C:/dist', 'P7 DSH Company Test').map(path => path.replaceAll('\\', '/'))).toEqual([
    'C:/dist/mac/P7 DSH Company Test.app/Contents/MacOS/P7 DSH Company Test',
    'C:/dist/mac-arm64/P7 DSH Company Test.app/Contents/MacOS/P7 DSH Company Test',
    'C:/dist/mac-universal/P7 DSH Company Test.app/Contents/MacOS/P7 DSH Company Test',
    'C:/dist/win-unpacked/P7 DSH Company Test.exe',
    'C:/dist/linux-unpacked/dsh-desktop-beta',
  ])
})
