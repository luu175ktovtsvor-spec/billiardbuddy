import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const desktopRoot = join(import.meta.dir, '..')
const sourceRoot = join(desktopRoot, '..', 'node_modules', '@fontsource', 'noto-sans-sc')
const destination = join(desktopRoot, 'runtime-assets', 'fonts')
const sourceFont = join(sourceRoot, 'files', 'noto-sans-sc-chinese-simplified-400-normal.woff')
const sourceLicense = join(sourceRoot, 'LICENSE')

async function stage(): Promise<void> {
  // This is a reviewed OFL font dependency, staged as a product asset rather
  // than discovered from each operating system's font registry.
  await stat(sourceFont)
  await mkdir(destination, { recursive: true })
  await Promise.all([
    copyFile(sourceFont, join(destination, 'BilliardBuddy-NotoSansCJKsc-Regular.woff')),
    copyFile(sourceLicense, join(destination, 'BilliardBuddy-NotoSansCJKsc-LICENSE')),
  ])
}

await stage()
