import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function visitPins(visit) {
  const files = git('ls-files', '-z', '.github/actions', '.github/workflows').split('\0')
  for (const file of files.filter(file => /\.ya?ml$/.test(file))) {
    const before = readFileSync(file, 'utf8')
    const lines = before.split('\n')
    // Parse YAML nodes, not description examples or shell heredocs. Edit only the
    // scalar's original line so comments, quoting, and unrelated formatting survive.
    const nodes = JSON.parse(execFileSync('yq', ['-o=json',
      '[.. | select(tag == "!!map" and has("uses")) | .uses | {"value": ., "line": line}]', file,
    ], { encoding: 'utf8' }))
    for (const { value, line } of nodes) {
      if (typeof value !== 'string' || !value.startsWith('wevm/actions/')) continue
      const match = value.match(/^wevm\/actions\/([\w./-]+)@([0-9a-f]{40})$/)
      if (!match || match[1].split('/').includes('..')) {
        throw new Error(`Expected full, immutable wevm/actions pin in ${file}: ${value}`)
      }
      if (!lines[line - 1]?.includes(value)) throw new Error(`Use a single-line action reference in ${file}:${line}`)
      const [, path, sha] = match
      lines[line - 1] = lines[line - 1].replace(value, `wevm/actions/${path}@${visit(path, sha)}`)
    }
    const after = lines.join('\n')
    if (after !== before) writeFileSync(file, after)
  }
}

export function refreshPins(base) {
  visitPins((path, sha) => {
    git('merge-base', '--is-ancestor', sha, base)
    git('cat-file', '-e', `${base}:${path}`)
    return base
  })
}

export function checkPins(head) {
  visitPins((path, sha) => {
    if (sha === head) throw new Error(`Self-referencing pin: ${path}`)
    git('merge-base', '--is-ancestor', sha, `${head}^1`)
    // A concurrent merge must not leave a release running an older vendor tree.
    if (git('rev-parse', `${sha}:${path}`) !== git('rev-parse', `${head}:${path}`)) {
      throw new Error(`Stale wrapper pin for ${path}; regenerate the version PR on current main`)
    }
    return sha
  })
}
