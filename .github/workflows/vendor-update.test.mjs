import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, yqJson } from '../../vendor/lib.mjs'

const steps = yqJson(join(ROOT, '.github/workflows/vendor-update.yml')).jobs.propose.steps
const script = steps.find((step) => step.name === 'Propose reviewed update').run
const apply = steps.find((step) => step.id === 'apply').run
const changesetScript = apply.slice(apply.indexOf('new_ref='), apply.indexOf('node --test'))
const name = 'example/action/v1'
const sha = 'a'.repeat(40)
const branch = `vendor/${name}-${sha}`

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-proposal-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'checkout')
  mkdirSync(root)
  mkdirSync(join(dir, 'bin'))
  const stateFile = join(dir, 'github.json')
  const env = {
    ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    FAKE_GH_STATE: stateFile, NAME: name, OLD_SHA: 'b'.repeat(40), NEW_SHA: sha,
    REPO: 'wevm/actions', GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  // Only GitHub is simulated. Commits, pushes and branch preservation use real Git.
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'api') {
  if (state.failLookup) process.exit(1);
  if (args.some(a => a.includes('?state=open'))) {
    console.log(JSON.stringify(state.prs.filter(p => p.state === 'open')));
  } else {
    const head = args.find(a => a.startsWith('head=')).split(':').slice(1).join(':');
    for (const p of state.prs.filter(p => p.head.ref === head)) console.log(p.number);
  }
} else if (args[0] === 'pr' && args[1] === 'create') {
  if (state.failCreate) process.exit(1);
  const value = flag => args[args.indexOf(flag) + 1];
  state.prs.push({number: state.prs.length + 1, state: 'open', head: {ref: value('--head'), repo: {full_name: value('--repo')}}, title: value('--title'), body: value('--body')});
  fs.writeFileSync(path, JSON.stringify(state));
} else { throw new Error('Unexpected GitHub command: ' + args.join(' ')); }
`, { mode: 0o755 })
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '--bare', join(dir, 'remote.git'))
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', join(dir, 'remote.git'))
  mkdirSync(join(root, 'vendor', name), { recursive: true })
  writeFileSync(join(root, 'vendor-manifest.yml'), JSON.stringify({ actions: [{ name, upstream: 'example/action', ref: 'v1.1.0' }] }))
  writeFileSync(join(root, 'README.md'), 'Before\n')
  writeFileSync(join(root, 'vendor', name, 'action.yml'), 'fixture\n')
  git('add', '.')
  git('commit', '-qm', 'Initial fixture')
  git('push', '-q', 'origin', 'main')
  writeFileSync(join(root, 'README.md'), 'Updated\n')
  const generated = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', changesetScript], {
    cwd: root, env: { ...env, new_sha: sha }, encoding: 'utf8',
  })
  assert.equal(generated.status, 0, generated.stderr)
  const save = state => writeFileSync(stateFile, JSON.stringify(state))
  save({ prs: [] })
  return {
    git, save, state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    run: () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: root, env, encoding: 'utf8' }),
    remote: () => git('ls-remote', '--heads', 'origin'),
  }
}

test('proposal retry recovers a pushed branch and never overwrites later reviewer edits', (t) => {
  const f = fixture(t)
  f.save({ prs: [], failCreate: true })
  assert.notEqual(f.run().status, 0)
  assert.equal(f.git('show', `HEAD:.changeset/vendor-example-action-v1-${sha}.md`),
    `---\n"@wevm/actions": patch\n---\n\nUpdate vendored \`${name}\` to \`v1.1.0\` (${sha}).`)
  f.git('commit', '--allow-empty', '-qm', 'Reviewer commit after the initial push')
  f.git('push', 'origin', `HEAD:refs/heads/${branch}`)
  const pushed = f.remote()
  assert.match(pushed, new RegExp(branch))
  f.save({ prs: [] })
  const retried = f.run()
  assert.equal(retried.status, 0, retried.stderr)
  assert.equal(f.remote(), pushed)
  assert.equal(f.state().prs.length, 1)
  assert.equal(f.state().prs[0].head.ref, branch)
  assert.match(f.state().prs[0].body, /example\/action\/compare\/b{40}\.\.\.a{40}/)
  const reviewed = f.state()
  reviewed.prs[0].body = 'Reviewer-owned description'
  f.save(reviewed)
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.state(), reviewed)
  assert.equal(f.remote(), pushed)
})

test('an older open proposal blocks another for the same slot, but not other slots or forks', (t) => {
  const f = fixture(t)
  const proposal = ref => ({ number: 10, state: 'open', head: { ref, repo: { full_name: 'wevm/actions' } }, body: 'Keep review' })
  const older = proposal(`vendor/${name}-${'c'.repeat(40)}`)
  f.save({ prs: [older] })
  const before = f.remote()
  assert.equal(f.run().status, 0)
  assert.equal(f.remote(), before)
  assert.deepEqual(f.state().prs, [older])
  const other = proposal(`vendor/${name}-other-${sha}`)
  const fork = { ...older, head: { ...older.head, repo: { full_name: 'other/actions' } } }
  f.save({ prs: [other, fork] })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.state().prs.length, 3)
  assert.equal(f.state().prs[2].head.ref, branch)
})

test('closed proposals stay closed and failed GitHub lookups do not publish', (t) => {
  const f = fixture(t)
  const before = f.remote()
  const reviewed = { prs: [{ number: 12, state: 'closed', head: { ref: branch, repo: { full_name: 'wevm/actions' } } }] }
  f.save(reviewed)
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.state(), reviewed)
  assert.equal(f.remote(), before)
  f.save({ prs: [], failLookup: true })
  assert.notEqual(f.run().status, 0)
  assert.equal(f.remote(), before)
  assert.deepEqual(f.state().prs, [])
})
