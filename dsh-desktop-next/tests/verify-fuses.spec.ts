import { expect, it } from 'vitest'
import { finalArtifactExecutablePaths } from '../scripts/verify-fuses.ts'

it('derives final artifact executable paths from the package product name', () => {
  expect(finalArtifactExecutablePaths('C:/dist', 'DSH NEXT').map(path => path.replaceAll('\\', '/'))).toEqual([
    'C:/dist/mac/DSH NEXT.app/Contents/MacOS/DSH NEXT',
    'C:/dist/mac-arm64/DSH NEXT.app/Contents/MacOS/DSH NEXT',
    'C:/dist/mac-universal/DSH NEXT.app/Contents/MacOS/DSH NEXT',
    'C:/dist/win-unpacked/DSH NEXT.exe',
    'C:/dist/linux-unpacked/dsh-desktop-next',
  ])
})
