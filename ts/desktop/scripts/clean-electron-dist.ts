import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const desktopRoot = path.resolve(import.meta.dir, '..')
const electronDistDir = path.join(desktopRoot, 'electron-dist')

await rm(electronDistDir, { recursive: true, force: true })
await mkdir(electronDistDir, { recursive: true })
console.log(`[clean-electron-dist] reset ${electronDistDir}`)
