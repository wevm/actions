import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { refreshPins } from './wrapper-pins.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const base = process.env.RELEASE_BASE_SHA
if (!/^[0-9a-f]{40}$/.test(base ?? '') || git('rev-parse', 'HEAD') !== base ||
    git('rev-parse', 'origin/main') !== base) {
  throw new Error('Version only the exact reviewed main commit supplied by Release workflow')
}

execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/@changesets/cli/bin.js', import.meta.url)), 'version'], { stdio: 'inherit' })
refreshPins(base)
// Only the root version changes; retain all dependency resolutions and integrity hashes.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
lock.version = lock.packages[''].version = version
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
