import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, yqJson } from '../../vendor/lib.mjs'

const workflow = name => yqJson(join(ROOT, '.github/workflows', name))

test('issue labeling posts the supplied message verbatim and closes the intended issue', (t) => {
  const definition = workflow('issue-labeled.yml')
  const job = Object.values(definition.jobs)[0]
  const step = job.steps[0]
  assert.equal(job.if, "github.repository_owner == 'wevm'")
  assert.equal(step.if, "github.event.label.name == 'needs reproduction'")
  const dir = mkdtempSync(join(tmpdir(), 'issue-workflow-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'issue.json')
  writeFileSync(stateFile, JSON.stringify({ state: 'open', comments: [] }))
  // Simulate the GitHub issue resource; never write to a real issue.
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const issue = JSON.parse(fs.readFileSync(process.env.ISSUE_STATE, 'utf8'));
const fields = Object.fromEntries(args.filter((_, i) => args[i - 1] === '--raw-field').map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
if (args.includes('POST')) {
  assert(args.includes('repos/wevm/fixture/issues/73/comments'));
  issue.comments.push(fields.body);
} else if (args.includes('PATCH')) {
  assert(args.includes('repos/wevm/fixture/issues/73'));
  Object.assign(issue, fields);
} else throw new Error('Unexpected mutation');
fs.writeFileSync(process.env.ISSUE_STATE, JSON.stringify(issue));
`, { mode: 0o755 })
  const body = 'Please reproduce: "quotes"\n$(exit 98); `exit 99` & literal shell syntax'
  const values = {
    'secrets.GITHUB_TOKEN': 'fixture-token',
    'github.repository': 'wevm/fixture',
    'github.event.issue.number': '73',
    'inputs.needs-reproduction-body': body,
  }
  const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => {
    const resolved = values[value.replace(/^\$\{\{\s*|\s*\}\}$/g, '')]
    assert.notEqual(resolved, undefined, value)
    return [key, resolved]
  }))
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
    env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}`, ISSUE_STATE: stateFile }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), {
    state: 'closed', state_reason: 'not_planned', comments: [body],
  })
})

test('both issue-locking workflows forward caller text and retain the issue-only 14-day policy', () => {
  for (const name of ['lock-issue.yml', 'lock-issue-v5.yml']) {
    const definition = workflow(name)
    assert.equal(definition.on.workflow_call.inputs['issue-comment'].type, 'string')
    const job = Object.values(definition.jobs)[0]
    assert.equal(job.if, "github.repository_owner == 'wevm'")
    assert.equal(job.steps[0].with['issue-comment'], '${{ inputs.issue-comment }}')
    assert.equal(job.steps[0].with['issue-inactive-days'], '14')
    assert.equal(job.steps[0].with['process-only'], 'issues')
    assert.equal(job.steps[0].with['issue-lock-reason'], 'resolved')
  }
})
