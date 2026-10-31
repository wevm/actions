import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ROOT, yqJson } from '../../vendor/lib.mjs'

const initial = '8963daf30237417f873c8e2f17e3bf9415e3a7b9'
const success = result => assert.equal(result.status, 0, result.stdout + result.stderr)

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'actions-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'checkout')
  const remote = join(dir, 'remote.git')
  const stateFile = join(dir, 'github.json')
  const eventFile = join(dir, 'event.json')
  mkdirSync(join(dir, 'bin'))
  const env = {
    ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    FAKE_GH_STATE: stateFile, FAKE_REMOTE: remote,
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventFile,
    GITHUB_OUTPUT: join(dir, 'output'), GH_TOKEN: 'fixture-not-a-real-token',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const command = (cmd, args, cwd = root, overrides = {}) => spawnSync(cmd, args, {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8',
  })
  const git = (...args) => { const r = command('git', args); success(r); return r.stdout.trim() }
  // Borrow local objects, including the actual immutable baseline, without copying
  // or executing the large vendor tree. Both working and bare repos are disposable.
  success(command('git', ['clone', '--shared', '--bare', ROOT, remote], dir))
  const tags = command('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/tags'], dir)
  success(tags)
  for (const tag of tags.stdout.trim().split('\n').filter(tag => tag && tag !== 'refs/tags/v1.0.0')) {
    success(command('git', ['--git-dir', remote, 'update-ref', '-d', tag], dir))
  }
  success(command('git', ['clone', '--shared', '--no-checkout', remote, root], dir))
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('update-ref', 'refs/heads/main', initial)
  git('read-tree', '--empty')
  const write = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), value)
  }
  const read = file => readFileSync(join(root, file), 'utf8')
  const save = value => writeFileSync(stateFile, JSON.stringify(value))
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  save({ releases: [], writes: [], prs: [] })
  const checked = () => {
    const sha = git('rev-parse', 'HEAD')
    env.GITHUB_SHA = sha
    writeFileSync(eventFile, JSON.stringify({ repository: { full_name: 'wevm/actions' }, workflow_run: { id: 17, head_sha: sha } }))
    save({ ...state(), run: { id: 17, path: '.github/workflows/vendor-check.yml', event: 'push',
      head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success',
      repository: { full_name: 'wevm/actions' }, head_repository: { full_name: 'wevm/actions' } } })
    return sha
  }
  const commit = () => {
    git('add', '-A')
    git('commit', '-qm', 'Reviewed fixture')
    // The bare fixture starts at the actual baseline, not the developer's branch.
    git('push', '-q', '--force', 'origin', 'HEAD:refs/heads/main')
    return checked()
  }
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'api') throw Error('Unexpected GitHub command');
const endpoint = args.find(a => a.startsWith('repos/wevm/actions/')).slice('repos/wevm/actions/'.length);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
if (state.failRead && !args.includes('POST')) process.exit(1);
let result;
if (endpoint.startsWith('actions/runs/')) result = state.run;
else if (endpoint.startsWith('commits/')) result = state.prs;
else if (endpoint === 'git/refs') {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'));
  cp.execFileSync('git', ['--git-dir', process.env.FAKE_REMOTE, 'update-ref', body.ref, body.sha, '0'.repeat(40)]);
  state.writes.push(body); result = body;
} else if (endpoint.startsWith('releases?')) result = [state.releases];
else if (endpoint === 'releases' && args.includes('POST')) {
  if (state.failRelease) process.exit(1);
  const body = JSON.parse(fs.readFileSync(0, 'utf8'));
  state.releases.push(body); state.writes.push(body); result = body;
} else throw Error('Unexpected GitHub endpoint: ' + endpoint);
fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
console.log(JSON.stringify(result));
`, { mode: 0o755 })
  for (const file of ['package.json', 'package-lock.json', '.changeset/config.json',
    '.github/scripts/release.mjs', '.github/scripts/version.mjs', '.github/scripts/wrapper-pins.mjs']) {
    write(file, readFileSync(join(ROOT, file), 'utf8'))
  }
  // Keep fixture versions independent of this repository's future releases.
  const pkg = JSON.parse(read('package.json')); pkg.version = '1.0.0'
  write('package.json', JSON.stringify(pkg))
  write('.gitignore', '/node_modules/\n')
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  write('vendor/example/action/v1/action.yml', 'old v1 runtime\n')
  write('vendor/example/action/v2/action.yml', 'independent v2 runtime\n')
  write('vendor/example/action/v1/package.json', '{"name":"upstream-action","version":"9.0.0"}\n')
  write('.github/actions/token/action.yml', 'name: unchanged first-party token wrapper\n')
  write('vendor-manifest.yml', 'unchanged fixture manifest\n')
  const setup = commit()
  const propose = () => {
    write('.github/actions/example/action.yml', `description: |\n  uses: wevm/actions/vendor/not-an-action@main\nruns:\n  using: composite\n  steps:\n    - uses: wevm/actions/vendor/example/action/v1@${setup} # retain major\n    - uses: wevm/actions/vendor/example/action/v2@${setup}\n`)
    write('.github/workflows/example.yml', `jobs:\n  example:\n    steps:\n      - uses: 'wevm/actions/vendor/example/action/v1@${setup}'\n      - {uses: 'wevm/actions/.github/actions/token@${setup}'}\n      - run: |\n          cat <<'EOF'\n          uses: wevm/actions/vendor/not-an-action@main\n          EOF\n`)
    write('vendor/example/action/v1/action.yml', 'reviewed new v1 runtime\n')
    write('.changeset/vendor-update.md', '---\n"@wevm/actions": patch\n---\n\nUpdate the reviewed v1 action.\n')
    return commit()
  }
  const version = () => {
    const base = git('rev-parse', 'HEAD')
    git('switch', '-C', 'changeset-release/main')
    const r = command('node', ['.github/scripts/version.mjs'], root, { RELEASE_BASE_SHA: base })
    success(r)
    git('add', '-A')
    git('commit', '-qm', 'Version snapshot')
    git('switch', 'main')
    git('merge', '--no-ff', '-m', 'Merge reviewed version PR', 'changeset-release/main')
    git('push', '-q', 'origin', 'main')
    const sha = checked()
    save({ ...state(), prs: [{ merged_at: '2026-10-31T00:00:00Z', merge_commit_sha: sha,
      base: { ref: 'main', repo: { full_name: 'wevm/actions' } },
      head: { ref: 'changeset-release/main', repo: { full_name: 'wevm/actions' } } }] })
    return sha
  }
  return { git, write, read, save, state, commit, checked, propose, version, setup, env,
    run: (publish = true, overrides = {}) => command('node', ['.github/scripts/release.mjs', ...(publish ? ['--publish'] : [])], root, overrides),
  }
}

test('setup and ordinary pushes never tag, publish, or backfill v1.0.0; pending changes only propose', t => {
  const f = fixture(t)
  assert.match(f.run().stdout, /Release mode: none/)
  f.write('ordinary.txt', 'not a release')
  f.commit()
  assert.match(f.run().stdout, /Release mode: none/)
  f.propose()
  assert.match(f.run().stdout, /Release mode: version/)
  assert.match(f.run(true, { GITHUB_SHA: initial }).stdout, /Release mode: none/)
  assert.deepEqual(f.state().writes, [])
  assert.equal(f.git('ls-remote', '--tags', 'origin', 'refs/tags/v1.0.1'), '')
})

test('real CLI versions private root, updates lock and wrapper pins, then releases exact SHA with changelog notes', t => {
  const f = fixture(t)
  const base = f.propose()
  const manifest = f.read('vendor-manifest.yml')
  const head = f.version()
  assert.equal(JSON.parse(f.read('package.json')).version, '1.0.1')
  const lock = JSON.parse(f.read('package-lock.json'))
  assert.equal(lock.version, '1.0.1')
  assert.equal(lock.packages[''].version, '1.0.1')
  assert.match(f.read('CHANGELOG.md'), /## 1.0.1\n[\s\S]*Update the reviewed v1 action/)
  for (const file of ['.github/actions/example/action.yml', '.github/workflows/example.yml']) {
    assert.match(f.read(file), new RegExp(`wevm/actions/vendor/example/action/v1@${base}`))
    assert(!f.read(file).includes(head))
  }
  assert.match(f.read('.github/actions/example/action.yml'), new RegExp(`/v2@${base}`))
  assert.match(f.read('.github/actions/example/action.yml'), /uses: wevm\/actions\/vendor\/not-an-action@main/)
  assert.match(f.read('.github/workflows/example.yml'), new RegExp(`\.github/actions/token@${base}`))
  assert.match(f.read('.github/workflows/example.yml'), /uses: wevm\/actions\/vendor\/not-an-action@main/)
  assert.equal(f.read('vendor-manifest.yml'), manifest)
  assert.equal(f.git('diff', '--name-only', base, head, 'vendor', 'vendor-manifest.yml'), '')
  success(f.run(false))
  assert.deepEqual(f.state().writes, [])
  success(f.run())
  assert.equal(f.git('ls-remote', '--tags', 'origin', 'refs/tags/v1.0.1').split('\t')[0], head)
  assert.equal(f.state().releases[0].target_commitish, head)
  assert.equal(f.state().releases[0].body, f.read('CHANGELOG.md').split('## 1.0.1\n')[1].trim())
  const released = f.state()
  success(f.run())
  assert.deepEqual(f.state(), released)
  assert.doesNotMatch(f.git('config', '--local', '--list'), /credential\.|extraheader/i)
})

test('retry after tag succeeds and release API fails creates only the missing release', t => {
  const f = fixture(t)
  f.propose(); const head = f.version()
  f.save({ ...f.state(), failRelease: true })
  assert.notEqual(f.run().status, 0)
  assert.equal(f.state().writes.length, 1)
  assert.match(f.git('ls-remote', '--tags', 'origin', 'refs/tags/v1.0.1'), new RegExp(head))
  f.save({ ...f.state(), failRelease: false })
  success(f.run())
  assert.equal(f.state().writes.length, 2)
  success(f.run())
  assert.equal(f.state().writes.length, 2)
  const edited = f.state()
  edited.releases[0].body = 'Manual release note edit'
  f.save(edited)
  assert.match(f.run().stderr, /release differs/)
  assert.deepEqual(f.state(), edited)
})

test('existing mismatched tags are never moved, including annotated tags; matching annotated tags are reusable', t => {
  const f = fixture(t)
  f.propose(); const head = f.version()
  f.git('tag', '-a', 'v1.0.1', f.setup, '-m', 'Existing other release')
  f.git('push', 'origin', 'refs/tags/v1.0.1')
  const before = f.git('ls-remote', '--tags', 'origin')
  assert.match(f.run().stderr, /already exists at another commit/)
  assert.equal(f.git('ls-remote', '--tags', 'origin'), before)
  assert.deepEqual(f.state().writes, [])
  // Only the test replaces this disposable tag, never production release code.
  f.git('tag', '-fa', 'v1.0.1', head, '-m', 'Correct pre-existing tag')
  f.git('push', '--force', 'origin', 'refs/tags/v1.0.1')
  success(f.run())
  assert.equal(f.state().writes.length, 1)
})

test('fails closed for wrong CI identity, SHA, incomplete/failed CI, unmerged PRs and failed lookups', t => {
  const f = fixture(t)
  f.propose(); f.version()
  const ready = f.state()
  for (const fields of [
    { path: '.github/workflows/other.yml' }, { head_sha: initial }, { event: 'pull_request' },
    { head_branch: 'feature' }, { status: 'in_progress' }, { conclusion: 'failure' },
    { head_repository: { full_name: 'fork/actions' } },
  ]) {
    f.save({ ...ready, run: { ...ready.run, ...fields } })
    assert.notEqual(f.run().status, 0, JSON.stringify(fields))
    assert.deepEqual(f.state().writes, [])
  }
  for (const fields of [{ prs: [] }, { failRead: true },
    { prs: [{ ...ready.prs[0], merged_at: null }] },
    { prs: [{ ...ready.prs[0], merge_commit_sha: initial }] },
    { prs: [{ ...ready.prs[0], head: { ref: 'other-branch', repo: { full_name: 'wevm/actions' } } }] },
  ]) {
    f.save({ ...ready, ...fields })
    assert.notEqual(f.run().status, 0)
    assert.deepEqual(f.state().writes, [])
  }
})

test('refuses an altered baseline and never publishes it', t => {
  const f = fixture(t)
  // Corrupt only the disposable remote, not the source repository's baseline.
  f.git('push', '--force', 'origin', `${f.setup}:refs/tags/v1.0.0`)
  assert.match(f.run().stderr, /Immutable v1.0.0 baseline differs/)
  assert.deepEqual(f.state().writes, [])
})

test('rejects stale vendor pins, pending changesets and missing notes before any tag write', t => {
  const f = fixture(t)
  f.propose(); f.version()
  const ready = f.state()
  const wrapper = f.read('.github/actions/example/action.yml')
  f.write('.github/actions/example/action.yml', wrapper.replace(/@[0-9a-f]{40}/g, `@${f.setup}`))
  assert.match(f.run().stderr, /Stale wrapper pin/)
  f.write('.github/actions/example/action.yml', wrapper.replace(/@[0-9a-f]{40}/g, `@${f.git('rev-parse', 'HEAD')}`))
  assert.match(f.run().stderr, /Self-referencing pin/)
  f.write('.github/actions/example/action.yml', wrapper.replace(/@[0-9a-f]{40}/g, '@main'))
  assert.match(f.run().stderr, /Expected full, immutable/)
  f.write('.github/actions/example/action.yml', wrapper)
  f.write('.changeset/late.md', '---\n"@wevm/actions": patch\n---\n\nLate change\n')
  assert.match(f.run().stderr, /Unconsumed changesets/)
  f.write('.changeset/late.md', '')
  // Remove the disposable pending file; neither this nor the stale wrapper was committed.
  f.git('clean', '-f', '--', '.changeset/late.md')
  f.write('CHANGELOG.md', '# No current entry\n')
  assert.match(f.run().stderr, /Missing current changelog entry/)
  assert.deepEqual(f.state().writes, ready.writes)
})

test('workflow uses compatible pinned tooling, CI-triggering STS, and no publish path in the version action', () => {
  const workflow = yqJson(join(ROOT, '.github/workflows/release.yml'))
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ['Vendor check'], types: ['completed'], branches: ['main'] } })
  assert.match(workflow.jobs.plan.if, /workflow_run.event == 'push'/)
  assert.match(workflow.jobs.plan.if, /workflow_run.conclusion == 'success'/)
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, '${{ github.event.workflow_run.head_sha }}')
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(checkout.with['fetch-depth'], 0)
  }
  const steps = workflow.jobs.version.steps
  const changesets = steps.find(step => step.uses?.includes('/changesets/'))
  assert.match(changesets.uses, /^wevm\/actions\/vendor\/changesets\/action\/abitype@[0-9a-f]{40}$/)
  for (const flag of ['create-github-releases', 'push-git-tags', 'push-with-git-cli']) assert.equal(changesets.with[flag], false)
  assert.equal(changesets.with['publish-script'], undefined)
  assert.equal(changesets.with['github-token'], '${{ steps.sts.outputs.token }}')
  assert(steps.findIndex(step => step.run?.startsWith('npm ci --ignore-scripts')) < steps.findIndex(step => step.id === 'sts'))
  const policy = yqJson(join(ROOT, '.github/sts/release-pr.sts.yaml'))
  assert.equal(policy.claim_pattern.event_name, 'workflow_run')
  assert.equal(policy.claim_pattern.repository_id, '804527424')
  assert.equal(policy.max_ttl, '5m')
  assert.deepEqual(policy.permissions, { contents: 'write', pull_requests: 'write', workflows: 'write' })
  assert(new RegExp(`^${policy.claim_pattern.workflow_ref}$`).test('wevm/actions/.github/workflows/release.yml@refs/heads/main'))
})

test('version PR text replaces npm boilerplate and retains generated changelog notes verbatim', () => {
  const workflow = yqJson(join(ROOT, '.github/workflows/release.yml'))
  const step = workflow.jobs.version.steps.find(step => step.name === 'Explain GitHub-only publication on the version PR')
  const filter = step.run.match(/jq -Rsr '([\s\S]*?)'\)/)[1]
  const notes = '\n\n## @wevm/actions@1.0.1\n\n### Patch Changes\n\n- Literal `code` and $text\n'
  const result = spawnSync('jq', ['-Rsr', filter], {
    input: `This PR was opened by Changesets. Publish to npm yourself.\n\n# Releases${notes}`, encoding: 'utf8',
  })
  success(result)
  assert.match(result.stdout, /only after the full Vendor check succeeds on the merge SHA/)
  assert.match(result.stdout, /Nothing is published to npm/)
  assert(!result.stdout.includes('Publish to npm yourself'))
  assert.equal(result.stdout.split('# Releases')[1], `${notes}\n`)
})
