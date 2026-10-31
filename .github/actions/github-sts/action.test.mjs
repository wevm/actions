import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { yqJson } from '../../../vendor/lib.mjs'

const action = yqJson(fileURLToPath(new URL('./action.yml', import.meta.url)))

test('GitHub STS accepts only the supported WEVM hosts before exchanging credentials', () => {
  const validation = action.runs.steps.find((step) => step.run)
  assert.equal(validation.env.STS_HOST, '${{ inputs.host }}')
  for (const host of ['gh-sts.wevm.run', 'staging.gh-sts.wevm.run', 'gh-sts.wevm.dev', 'staging.gh-sts.wevm.dev']) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], { env: { ...process.env, STS_HOST: host }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  for (const host of ['', 'gh-sts.wevm.run.attacker.test', 'https://gh-sts.wevm.run', 'gh-sts.wevm.run\ninjected']) {
    const result = spawnSync('bash', ['-e', '-c', validation.run], { env: { ...process.env, STS_HOST: host }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /host must be/)
  }
})

test('GitHub STS forwards its public inputs and exposes both upstream outputs', () => {
  const exchange = action.runs.steps.find((step) => step.uses)
  assert.equal(action.inputs.host.default, 'gh-sts.wevm.run')
  assert.equal(action.inputs.policy.required, true)
  for (const input of ['scope', 'policy', 'ttl', 'host', 'retry-timeout']) {
    assert.equal(exchange.with[input], '${{ inputs.' + input + ' }}', input)
  }
  for (const output of ['token', 'expires-at']) {
    assert.equal(action.outputs[output].value, '${{ steps.' + exchange.id + '.outputs.' + output + ' }}', output)
  }
})
