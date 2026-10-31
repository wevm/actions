import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { checkPins } from './wrapper-pins.mjs'

const repo = 'wevm/actions'
const initial = '8963daf30237417f873c8e2f17e3bf9415e3a7b9'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const api = (path, body) => JSON.parse(execFileSync('gh', [
  'api', `repos/${repo}/${path}`,
  ...(body ? ['--method', 'POST', '--input', '-'] : []),
], { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined }))
const output = mode => {
  console.log(`Release mode: ${mode}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`)
}

function tagTarget(tag) {
  const refs = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
    .split('\n').filter(Boolean).map(line => line.split(/\s+/))
  return refs.find(([, ref]) => ref.endsWith('^{}'))?.[0] ?? refs[0]?.[0]
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const head = git('rev-parse', 'HEAD')
const run = event.workflow_run
if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || event.repository?.full_name !== repo ||
    !run || run.head_sha !== head) throw new Error('Not a Vendor check completion for this checkout')
// Re-read the complete workflow result, not just one check/job or caller-supplied status.
const checked = api(`actions/runs/${run.id}`)
if (checked.path !== '.github/workflows/vendor-check.yml' || checked.head_sha !== head ||
    checked.head_branch !== 'main' || checked.event !== 'push' || checked.status !== 'completed' ||
    checked.conclusion !== 'success' || checked.repository?.full_name !== repo ||
    checked.head_repository?.full_name !== repo) throw new Error('Exact main commit has not passed full Vendor check')
git('merge-base', '--is-ancestor', head, 'origin/main')
if (tagTarget('v1.0.0') !== initial) throw new Error('Immutable v1.0.0 baseline differs')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== '@wevm/actions' || pkg.private !== true || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error('Expected one private, stable-version @wevm/actions package')
}
const pending = readdirSync('.changeset').filter(file => file.endsWith('.md') && file !== 'README.md')
// The setup commit has no parent package. v1.0.0 is never republished or backfilled.
let previous
if (git('ls-tree', '--name-only', `${head}^1`, 'package.json')) {
  previous = JSON.parse(git('show', `${head}^1:package.json`)).version
}
if (!previous || previous === pkg.version || pkg.version === '1.0.0') {
  // Changesets/action uses github.context.sha as its base, even after checkout.
  // Never let an older workflow_run reset the version PR onto another commit.
  output(pending.length && head === git('rev-parse', 'origin/main') && head === process.env.GITHUB_SHA ? 'version' : 'none')
} else {
  const old = previous.split('.').map(Number)
  const next = pkg.version.split('.').map(Number)
  const differing = next.findIndex((part, i) => part !== old[i])
  if (differing < 0 || next[differing] <= old[differing]) throw new Error('Version must increase')
  if (pending.length) throw new Error('Unconsumed changesets; regenerate and review the version PR')
  const prs = api(`commits/${head}/pulls?per_page=100`)
  if (!prs.some(pr => pr.merged_at && pr.merge_commit_sha === head &&
      pr.base.ref === 'main' && pr.base.repo.full_name === repo &&
      pr.head.ref === 'changeset-release/main' && pr.head.repo?.full_name === repo)) {
    throw new Error('Version change is not a merged Changesets version PR')
  }
  checkPins(head)
  const changelog = readFileSync('CHANGELOG.md', 'utf8')
  const sections = changelog.split(/^## /m).slice(1)
  if (sections[0]?.split('\n')[0].trim() !== pkg.version) throw new Error('Missing current changelog entry')
  const notes = sections[0].slice(sections[0].indexOf('\n')).trim()
  if (!notes) throw new Error('Empty release notes')
  const tag = `v${pkg.version}`
  const existing = tagTarget(tag)
  if (existing && existing !== head) throw new Error(`${tag} already exists at another commit; never move tags`)
  output('release')
  if (process.argv.includes('--publish')) {
    // Explicit SHA, create-only API: no implicit tag on the latest default branch,
    // no force push, no persisted Git credentials, and safe after a partial failure.
    if (!existing) api('git/refs', { ref: `refs/tags/${tag}`, sha: head })
    if (tagTarget(tag) !== head) throw new Error(`Remote ${tag} does not match the checked commit`)
    const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
      `repos/${repo}/releases?per_page=100`], { encoding: 'utf8' })).flat()
    const released = releases.find(release => release.tag_name === tag)
    if (released) {
      if (released.draft || released.prerelease || released.body.trim() !== notes) {
        throw new Error(`Existing ${tag} release differs; inspect it manually (not overwritten)`)
      }
      console.log(`${tag} already released; unchanged`)
    } else {
      api('releases', { tag_name: tag, target_commitish: head, name: tag, body: notes,
        draft: false, prerelease: false, make_latest: 'legacy' })
    }
  }
}
