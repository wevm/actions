import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Only application-account tokens are supported. Never target the STS account.
const accountId = '87fe88909d057ae3212762565f9d8c5b'
const hosts = ['cf-sts.wevm.run', 'staging.cf-sts.wevm.run']

async function request(url, method, bearer, label) {
  const deadline = Date.now() + 90_000
  for (let attempt = 0; attempt < 5; attempt++) {
    let response
    let body
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
        redirect: 'error',
        signal: AbortSignal.timeout(
          Math.min(60_000, Math.max(1, deadline - Date.now())),
        ),
      })
      body = await response.text()
    } catch {
      // Network errors can contain request details; never print them.
    }
    if (body !== undefined && response.ok) {
      if (response.status === 204) return { status: 204 }
      try {
        return { status: response.status, data: JSON.parse(body) }
      } catch {
        throw new Error(`${label}: invalid JSON response`)
      }
    }
    const transient =
      body === undefined ||
      [408, 425, 429].includes(response.status) ||
      response.status >= 500
    if (!transient) throw new Error(`${label}: HTTP ${response.status}`)
    const retryAfter = response?.headers.get('retry-after')
    const serverDelay =
      retryAfter == null
        ? 0
        : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0
    const delay = Math.max(1000 * 2 ** attempt, serverDelay)
    if (attempt === 4 || Date.now() + delay >= deadline)
      throw new Error(`${label}: retry budget exhausted`)
    await sleep(delay)
  }
}

export async function run(phase) {
  const env = process.env
  if (phase === 'revoke' && !env.STATE_token_id) {
    console.log('No Cloudflare token was issued; nothing to revoke.')
    return
  }
  const host = phase === 'mint' ? env.INPUT_HOST || hosts[0] : env.STATE_host
  const account =
    phase === 'mint' ? env.INPUT_ACCOUNT || 'wevm' : env.STATE_account
  const policy = phase === 'mint' ? env.INPUT_POLICY : env.STATE_policy
  if (!hosts.includes(host))
    throw new Error('Unsupported Wevm Cloudflare STS host')
  if (account !== 'wevm')
    throw new Error('Only the wevm resource account is supported')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(policy || ''))
    throw new Error('A valid trust policy is required')
  const query = new URLSearchParams({ account, identity: policy })
  if (phase === 'mint') {
    const ttl = env.INPUT_TTL || '15m'
    const match = /^(\d+)(s|m|h)$/.exec(ttl)
    const seconds =
      match && Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]]
    if (!seconds || seconds > 3600)
      throw new Error('TTL must be between 1s and 1h')
    query.set('ttl', ttl)
  } else {
    if (!/^[0-9a-f]{32}$/.test(env.STATE_token_id || ''))
      throw new Error('Invalid saved Cloudflare token ID')
    query.set('token_id', env.STATE_token_id)
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error('The job requires id-token: write')
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL)
  oidcUrl.searchParams.set('audience', host)
  const { data: oidc } = await request(
    oidcUrl,
    'GET',
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'GitHub OIDC',
  )
  if (
    typeof oidc?.value !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,16384}$/.test(oidc.value)
  )
    throw new Error('Invalid GitHub OIDC response')
  console.log(`::add-mask::${oidc.value}`)
  const result = await request(
    `https://${host}/sts/exchange?${query}`,
    phase === 'mint' ? 'POST' : 'DELETE',
    oidc.value,
    'Cloudflare STS',
  )
  if (phase === 'revoke') {
    if (result.status !== 204)
      throw new Error('Cloudflare STS did not confirm revocation')
    console.log('Cloudflare API token revoked and deleted.')
    return
  }
  const data = result.data
  // Save ownership before validating the rest, so post-job cleanup can still run.
  if (/^[0-9a-f]{32}$/.test(data?.token_id || '')) {
    for (const [key, value] of Object.entries({
      token_id: data.token_id,
      host,
      account,
      policy,
    }))
      appendFileSync(env.GITHUB_STATE, `${key}=${value}\n`)
  }
  if (
    typeof data?.token !== 'string' ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(data.token)
  )
    throw new Error('Cloudflare STS returned an invalid token')
  console.log(`::add-mask::${data.token}`)
  if (
    !/^[0-9a-f]{32}$/.test(data.token_id || '') ||
    data.account_id !== accountId ||
    typeof data.expires_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(data.expires_at) ||
    !(Date.parse(data.expires_at) > Date.now())
  )
    throw new Error('Cloudflare STS returned invalid token metadata')
  for (const [key, value] of Object.entries({
    token: data.token,
    'account-id': data.account_id,
    'expires-at': data.expires_at,
  }))
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
