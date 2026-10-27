import { execFileSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const message = 'ci: apply automated fixes'
const maxBytes = 5 * 1024 * 1024

// Artifacts originate on a runner executing PR code. Validate them again on the
// publisher, and never accept branch names, SHAs, commands, or credentials there.
export function validateChanges(changes) {
  if (!changes || !Array.isArray(changes.additions) || !Array.isArray(changes.deletions))
    throw new Error('Invalid autofix file changes')
  const paths = new Set()
  let bytes = 0
  const result = { additions: [], deletions: [] }
  for (const kind of ['additions', 'deletions']) {
    for (const file of changes[kind]) {
      const path = file?.path
      if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f]/.test(path) ||
          path.split('/').some(part => !part || part === '.' || part === '..' ||
            ['.git', '.github'].includes(part.toLowerCase())) || paths.has(path))
        throw new Error('Unsafe or duplicate autofix path')
      paths.add(path)
      if (kind === 'additions') {
        if (typeof file.contents !== 'string' ||
            Buffer.from(file.contents, 'base64').toString('base64') !== file.contents)
          throw new Error('Invalid base64 file contents')
        bytes += Buffer.byteLength(file.contents, 'base64')
        result.additions.push({ path, contents: file.contents })
      } else result.deletions.push({ path })
    }
  }
  if (!paths.size || paths.size > 100 || bytes > maxBytes)
    throw new Error('Autofix must change 1–100 files totaling at most 5 MiB')
  return result
}

export function collect(cwd, directory) {
  const git = (...args) => execFileSync('git', args, { cwd })
  // Only tracked files: do not accidentally commit build output or local files.
  const names = git('diff', '--name-only', '--no-renames', '-z', 'HEAD').toString().split('\0').filter(Boolean)
  if (!names.length) return false
  const changes = { additions: [], deletions: [] }
  for (const path of names) {
    const original = git('ls-tree', 'HEAD', '--', path).toString()
    if (original && !original.startsWith('100644 '))
      throw new Error(`Autofix only supports regular non-executable files: ${path}`)
    let stat
    try { stat = lstatSync(join(cwd, path)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!stat) changes.deletions.push({ path })
    else {
      if (!stat.isFile() || (stat.mode & 0o111))
        throw new Error(`Autofix only supports regular non-executable files: ${path}`)
      changes.additions.push({ path, contents: readFileSync(join(cwd, path)).toString('base64') })
    }
  }
  const validated = validateChanges(changes)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'fixes.json'), JSON.stringify(validated))
  writeFileSync(join(directory, 'fixes.patch'), git('diff', '--binary', '--no-ext-diff', 'HEAD'))
  return true
}

export async function publish(event, changes, request) {
  const { repository, pull_request: pr } = event
  if (!pr || pr.head.repo?.id !== repository.id ||
      pr.head.ref === repository.default_branch || pr.head.ref === pr.base.ref ||
      pr.user.login === 'dependabot[bot]')
    throw new Error('Only same-repository, non-Dependabot PR branches can receive fixes')
  const files = validateChanges(changes)
  const route = `/repos/${repository.full_name}`
  const live = await request(`${route}/pulls/${pr.number}`)
  if (live.state !== 'open' || live.head.repo?.id !== repository.id ||
      live.head.ref !== pr.head.ref || live.head.sha !== pr.head.sha)
    return { skipped: 'PR closed or head changed; leaving it untouched' }
  const head = await request(`${route}/commits/${pr.head.sha}`)
  if (head.commit.message.split('\n')[0] === message)
    throw new Error('Autofix would change its own fix commit; apply the artifact manually')

  const tree = await request(`${route}/git/trees/${head.commit.tree.sha}?recursive=1`)
  if (tree.truncated) throw new Error('Repository tree is too large to validate safely')
  const modes = new Map(tree.tree.map(entry => [entry.path, entry.mode]))
  for (const file of [...files.additions, ...files.deletions]) {
    if (modes.get(file.path) !== '100644')
      throw new Error('Autofix may only change existing regular non-executable files')
  }

  // The GitHub API, not a local checkout, constructs the commit. No artifact or
  // PR file is executed. expectedHeadOid atomically rejects concurrent pushes.
  const result = await request('/graphql', {
    query: `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { url } }
    }`,
    variables: { input: {
      branch: { repositoryNameWithOwner: repository.full_name, branchName: pr.head.ref },
      expectedHeadOid: pr.head.sha,
      message: { headline: message },
      fileChanges: files,
    } },
  })
  if (result.errors?.length) throw new Error('GitHub refused the autofix commit; the branch may have moved')
  const url = result.data?.createCommitOnBranch?.commit?.url
  if (!url) throw new Error('GitHub did not confirm the autofix commit')
  return { url }
}

async function main() {
  const directory = process.env.AUTOFIX_DIRECTORY
  if (!directory) throw new Error('Missing artifact directory')
  if (process.env.AUTOFIX_MODE === 'collect') {
    const changed = collect(process.cwd(), directory)
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
  } else if (process.env.AUTOFIX_MODE === 'publish') {
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Only pull_request events can publish')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    if (event.repository.full_name !== process.env.GITHUB_REPOSITORY || event.repository.owner.login !== 'wevm')
      throw new Error('Unexpected repository')
    const artifact = readFileSync(join(directory, 'fixes.json'))
    if (artifact.length > 2 * maxBytes) throw new Error('Autofix artifact is too large')
    const request = async (path, body) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      // Never retry a mutation after an ambiguous network failure.
      if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
      return response.json()
    }
    const result = await publish(event, JSON.parse(artifact), request)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      result.url ? `Applied fixes: ${result.url}\n` : `${result.skipped}\n`)
  } else throw new Error('Unknown autofix mode')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
