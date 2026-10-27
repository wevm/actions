import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collect, publish } from './index.mjs'

const event = {
  repository: { id: 123, full_name: 'wevm/example', default_branch: 'main' },
  pull_request: {
    number: 7, user: { login: 'contributor' }, base: { ref: 'main' },
    head: { repo: { id: 123 }, ref: 'fix/format', sha: 'a'.repeat(40) },
  },
}
const changes = {
  additions: [{ path: 'src/example.ts', contents: Buffer.from('const x = 2\n').toString('base64') }],
  deletions: [{ path: 'old.txt' }],
}

// Model GitHub's branch state, including the atomic expectedHeadOid check.
function server({ head = event.pull_request.head, state = 'open', message = 'Fix a bug', race = false, mode = '100644' } = {}) {
  let branch = head.sha
  let committed
  return {
    get committed() { return committed },
    request: async (path, body) => {
      if (path.endsWith('/pulls/7')) return { state, head }
      if (path.includes('/commits/')) return { commit: { message, tree: { sha: 'c'.repeat(40) } } }
      if (path.includes('/git/trees/')) return {
        truncated: false,
        tree: ['src/example.ts', 'text.txt', 'old.txt'].map(path => ({ path, mode })),
      }
      assert.equal(path, '/graphql')
      const input = body.variables.input
      assert.deepEqual(input.branch, { repositoryNameWithOwner: 'wevm/example', branchName: 'fix/format' })
      if (race) branch = 'b'.repeat(40)
      if (input.expectedHeadOid !== branch) return { errors: [{ message: 'Head moved' }] }
      committed = input.fileChanges
      return { data: { createCommitOnBranch: { commit: { url: 'https://github.com/wevm/example/commit/fix' } } } }
    },
  }
}

test('collect produces an applicable patch and publication preserves bytes and deletions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wevm-autofix-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir })
  git('init', '-q')
  writeFileSync(join(dir, 'text.txt'), 'before\n')
  writeFileSync(join(dir, 'old.txt'), 'remove me\n')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial')
  const output = join(dir, 'artifact')
  assert.equal(collect(dir, output), false)
  writeFileSync(join(dir, 'text.txt'), 'after\r\n☃\n')
  rmSync(join(dir, 'old.txt'))
  writeFileSync(join(dir, 'untracked.txt'), 'must not publish')
  assert.equal(collect(dir, output), true)
  const files = JSON.parse(readFileSync(join(output, 'fixes.json')))
  const api = server()
  await publish(event, files, api.request)
  assert.deepEqual(api.committed, {
    additions: [{ path: 'text.txt', contents: Buffer.from('after\r\n☃\n').toString('base64') }],
    deletions: [{ path: 'old.txt' }],
  })
  git('reset', '--hard', '-q', 'HEAD')
  git('apply', join(output, 'fixes.patch'))
  assert.equal(readFileSync(join(dir, 'text.txt'), 'utf8'), 'after\r\n☃\n')
  rmSync(join(dir, 'text.txt'))
  symlinkSync('untracked.txt', join(dir, 'text.txt'))
  assert.throws(() => collect(dir, output), /regular non-executable/)
})

test('closed, superseded, fork, base-branch and Dependabot PRs cannot be modified', async () => {
  for (const overrides of [{ state: 'closed' }, { head: { ...event.pull_request.head, sha: 'b'.repeat(40) } }]) {
    const api = server(overrides)
    assert.ok((await publish(event, changes, api.request)).skipped)
    assert.equal(api.committed, undefined)
  }
  for (const modify of [
    pr => { pr.head.repo.id = 999 },
    pr => { pr.head.ref = 'main' },
    pr => { pr.user.login = 'dependabot[bot]' },
  ]) {
    const input = structuredClone(event)
    modify(input.pull_request)
    const api = server()
    await assert.rejects(publish(input, changes, api.request), /Only same-repository/)
    assert.equal(api.committed, undefined)
  }
})

test('a push racing with publication is rejected rather than overwritten', async () => {
  const api = server({ race: true })
  await assert.rejects(publish(event, changes, api.request), /GitHub refused/)
  assert.equal(api.committed, undefined)
})

test('non-idempotent fixes cannot create an automatic commit loop', async () => {
  const api = server({ message: 'ci: apply automated fixes\n\nDetails' })
  await assert.rejects(publish(event, changes, api.request), /own fix commit/)
  assert.equal(api.committed, undefined)
})

test('publisher rejects malicious artifacts, independently of collector checks', async () => {
  const invalid = [
    ...['.github/sts/autofix.sts.yaml', 'a/.Git/config', '../escape', '/absolute', 'a//b', 'a\\b'].map(path => ({ additions: [{ path, contents: 'YQ==' }], deletions: [] })),
    { additions: [{ path: 'safe.txt', contents: 'not-base64' }], deletions: [] },
    { additions: changes.additions, deletions: [{ path: 'src/example.ts' }] },
    { additions: [], deletions: [] },
    { additions: [{ path: 'huge.txt', contents: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }], deletions: [] },
    { additions: [{ path: 'untracked.txt', contents: 'YQ==' }], deletions: [] },
  ]
  for (const files of invalid) {
    const api = server()
    await assert.rejects(publish(event, files, api.request))
    assert.equal(api.committed, undefined)
  }
  for (const mode of ['120000', '100755', '160000']) {
    const api = server({ mode })
    await assert.rejects(publish(event, changes, api.request), /existing regular/)
    assert.equal(api.committed, undefined)
  }
  // Extra artifact fields must not override the event's target or expected SHA.
  const api = server()
  await publish(event, { ...changes, branch: 'main', expectedHeadOid: 'b'.repeat(40) }, api.request)
  assert.deepEqual(api.committed, changes)
})
