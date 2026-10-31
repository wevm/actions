import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { run } from './client.mjs'

const originalEnv = { ...process.env }
const token = 'test-token-'.repeat(4)
const tokenId = '1234567890abcdef1234567890abcdef'
let directory
let messages
let issued
let revoked
let failures
let metadata

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wevm-sts-'))
  process.env = {
    ...originalEnv,
    INPUT_POLICY: 'deploy',
    INPUT_HOST: 'staging.cf-sts.wevm.run',
    INPUT_ACCOUNT: 'wevm',
    INPUT_TTL: '5m',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-secret',
    GITHUB_OUTPUT: join(directory, 'outputs'),
    GITHUB_STATE: join(directory, 'state'),
  }
  writeFileSync(process.env.GITHUB_OUTPUT, '')
  writeFileSync(process.env.GITHUB_STATE, '')
  messages = []
  issued = false
  revoked = false
  failures = 0
  metadata = { account_id: '87fe88909d057ae3212762565f9d8c5b' }
  mock.method(console, 'log', (message) => messages.push(message))
  mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input)
    if (url.hostname === 'oidc.test') {
      assert.equal(url.searchParams.get('audience'), 'staging.cf-sts.wevm.run')
      return Response.json({
        value: issued ? 'fresh.cleanup.assertion' : 'mint.assertion',
      })
    }
    assert.equal(url.origin, 'https://staging.cf-sts.wevm.run')
    assert.equal(url.pathname, '/sts/exchange')
    assert.equal(url.searchParams.get('account'), 'wevm')
    assert.equal(url.searchParams.get('identity'), 'deploy')
    if (options.method === 'DELETE') {
      assert.equal(url.searchParams.get('token_id'), tokenId)
      assert.equal(
        options.headers.authorization,
        'Bearer fresh.cleanup.assertion',
      )
      revoked = true
      return new Response(null, { status: 204 })
    }
    if (failures-- > 0)
      return new Response('sensitive provider error', { status: 503 })
    assert.equal(url.searchParams.get('ttl'), '5m')
    issued = true
    return Response.json({
      token,
      token_id: tokenId,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      ...metadata,
    })
  })
})

afterEach(() => {
  mock.restoreAll()
  process.env = originalEnv
  rmSync(directory, { recursive: true, force: true })
})

function restorePostState() {
  for (const line of readFileSync(process.env.GITHUB_STATE, 'utf8')
    .trim()
    .split('\n')) {
    const [key, value] = line.split('=')
    process.env[`STATE_${key}`] = value
  }
}

test('masks and outputs a token, then revokes with fresh OIDC and saved inputs', async () => {
  await run('mint')
  assert.match(
    readFileSync(process.env.GITHUB_OUTPUT, 'utf8'),
    new RegExp(`token=${token}\n`),
  )
  assert(messages.includes(`::add-mask::${token}`))
  assert(!readFileSync(process.env.GITHUB_STATE, 'utf8').includes(token))
  restorePostState()
  process.env.INPUT_HOST = 'cf-sts.wevm.run'
  process.env.INPUT_POLICY = 'different-policy'
  await run('revoke')
  assert(revoked)
  assert(messages.includes('Cloudflare API token revoked and deleted.'))
})

test('rejects a wrong account response but still cleans up its issued token', async () => {
  metadata.account_id = 'f'.repeat(32)
  await assert.rejects(run('mint'), /invalid token metadata/)
  assert.equal(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), '')
  restorePostState()
  await run('revoke')
  assert(revoked)
})

test('retries a transient exchange failure', async () => {
  failures = 1
  await run('mint')
  assert(issued)
})

test('fails closed on denial without printing the response body', async () => {
  mock.method(
    globalThis,
    'fetch',
    async () => new Response('secret-response', { status: 403 }),
  )
  await assert.rejects(run('mint'), { message: 'GitHub OIDC: HTTP 403' })
  assert(!messages.join('\n').includes('secret-response'))
  await run('revoke')
  assert(!revoked)
})

test('rejects foreign hosts, accounts, malformed policies and excessive TTLs before issuance', async () => {
  for (const [key, value, message] of [
    ['INPUT_HOST', 'cf-sts.wevm.run.attacker.test', /Unsupported/],
    ['INPUT_ACCOUNT', 'infra', /resource account/],
    ['INPUT_POLICY', 'deploy\ninjected=yes', /valid trust policy/],
    ['INPUT_TTL', '3601s', /TTL/],
    ['INPUT_TTL', '0s', /TTL/],
  ]) {
    const previous = process.env[key]
    process.env[key] = value
    await assert.rejects(run('mint'), message)
    process.env[key] = previous
  }
  assert(!issued)
})
