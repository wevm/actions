import { run } from './client.mjs'

await run('revoke').catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
