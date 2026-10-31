import { run } from './client.mjs'

await run('mint').catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
