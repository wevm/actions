import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, README_BEGIN, README_END } from './lib.mjs'

// Exercise the CLI against real local Git history, with no GitHub or network access.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-update-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const upstream = join(dir, 'upstream')
  const root = join(dir, 'actions')
  mkdirSync(upstream)
  mkdirSync(join(root, 'vendor'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${upstream}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/example/action',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: upstream, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(upstream, 'action.yml'), 'name: Fixture\ndescription: Fixture\nruns:\n  using: node24\n  main: index.js\n')
  function release(ref, days, annotated = false) {
    env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = new Date(Date.now() - days * 86400000).toISOString()
    writeFileSync(join(upstream, 'index.js'), `console.log(${JSON.stringify(ref)})\n`)
    git('add', '.')
    git('commit', '-qm', ref)
    git('tag', ...(annotated ? ['-a', '-m', ref] : []), ref)
    return git('rev-parse', 'HEAD')
  }
  const current = release('v1.0.0', 30)
  const entry = { name: 'example/action/v1', upstream: 'example/action', ref: 'v1.0.0', ref_type: 'tag', sha: current }
  const manifest = { org: 'wevm/actions', self_sha: current, self_tag: 'fixture', actions: [entry] }
  function save() { writeFileSync(join(root, 'vendor-manifest.yml'), JSON.stringify(manifest)) }
  save()
  writeFileSync(join(root, 'README.md'), `${README_BEGIN}\n${README_END}\n`)
  for (const file of ['update.mjs', 'sync.mjs', 'lib.mjs']) copyFileSync(join(ROOT, 'vendor', file), join(root, 'vendor', file))
  function run(...args) {
    return spawnSync(process.execPath, ['vendor/update.mjs', ...args], { cwd: root, env, encoding: 'utf8' })
  }
  return { root, upstream, env, git, release, entry, save, run }
}

test('CLI selects and applies the newest eligible same-major release, not a newer cooling release', (t) => {
  const f = fixture(t)
  f.release('v1.1.0', 20)
  const eligible = f.release('v1.2.0', 7, true)
  f.release('v1.3.0', 6)
  f.release('v1.4.0-beta.1', 15)
  f.release('v2.0.0', 15)
  const result = f.run('--json')
  assert.equal(result.status, 0, result.stderr)
  const [update] = JSON.parse(result.stdout)
  assert.equal(update.new_ref, 'v1.2.0')
  assert.equal(update.new_sha, eligible)
  assert.equal(JSON.parse(f.run('--json', '--all').stdout)[0].new_ref, 'v1.3.0')
  const applied = f.run('--apply', f.entry.name)
  assert.equal(applied.status, 0, applied.stderr)
  const manifest = spawnSync('yq', ['-o=json', '.', join(f.root, 'vendor-manifest.yml')], { encoding: 'utf8' })
  assert.equal(JSON.parse(manifest.stdout).actions[0].sha, eligible)
  assert.equal(readFileSync(join(f.root, 'vendor/example/action/v1/index.js'), 'utf8'), 'console.log("v1.2.0")\n')
})

test('CLI distinguishes no eligible updates from unavailable upstreams and missing tracked refs', (t) => {
  const f = fixture(t)
  f.release('v1.1.0', 1)
  assert.equal(f.run('--json').stdout.trim(), '[]')
  for (const [ref_type, ref] of [['tag', 'missing'], ['branch', 'missing']]) {
    Object.assign(f.entry, { ref_type, ref })
    f.save()
    const result = f.run('--json')
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /missing/)
  }
  rmSync(f.upstream, { recursive: true })
  const failed = f.run('--json')
  assert.notEqual(failed.status, 0)
  assert.equal(failed.stdout, '')
  assert.match(failed.stderr, /failed/)
})

test('CLI follows branch and moving-tag pins but leaves bare commits alone', (t) => {
  const f = fixture(t)
  const next = f.release('v1.1.0', 10)
  f.git('tag', 'v1')
  for (const [ref_type, ref] of [['branch', 'main'], ['tag', 'v1']]) {
    Object.assign(f.entry, { ref_type, ref })
    f.save()
    const result = f.run('--json')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)[0].new_sha, next)
  }
  f.entry.ref_type = 'commit'
  f.save()
  rmSync(f.upstream, { recursive: true })
  const pinned = f.run('--json')
  assert.equal(pinned.status, 0, pinned.stderr)
  assert.deepEqual(JSON.parse(pinned.stdout), [])
})

test('CLI does not downgrade when only older tags remain and rejects invalid cooldowns', (t) => {
  const f = fixture(t)
  Object.assign(f.entry, { ref: 'v1.2.0', sha: f.release('v1.2.0', 20) })
  f.git('tag', '-d', 'v1.2.0')
  f.save()
  assert.deepEqual(JSON.parse(f.run('--json').stdout), [])
  for (const days of ['NaN', '-1']) {
    const result = f.run('--json', '--min-age-days', days)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /min-age-days/)
  }
})
