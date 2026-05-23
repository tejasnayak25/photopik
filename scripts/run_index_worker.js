#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')

function loadLocalEnv() {
  const candidateFiles = ['.env.local', '.env']
  for (const file of candidateFiles) {
    const envPath = path.join(process.cwd(), file)
    if (!fs.existsSync(envPath)) continue
    const content = fs.readFileSync(envPath, 'utf8')
    const lines = content.split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex <= 0) continue
      const key = trimmed.slice(0, eqIndex).trim()
      let value = trimmed.slice(eqIndex + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] == null) {
        process.env[key] = value
      }
    }
  }
}

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://localhost:3000',
    limit: 20,
    iterations: 1,
  }

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--baseUrl' && argv[index + 1]) args.baseUrl = argv[++index]
    if (token.startsWith('--baseUrl=')) args.baseUrl = token.split('=')[1]
    if (token === '--limit' && argv[index + 1]) args.limit = Number(argv[++index])
    if (token.startsWith('--limit=')) args.limit = Number(token.split('=')[1])
    if (token === '--iterations' && argv[index + 1]) args.iterations = Number(argv[++index])
    if (token.startsWith('--iterations=')) args.iterations = Number(token.split('=')[1])
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error('--limit must be a positive number')
  }
  if (!Number.isFinite(args.iterations) || args.iterations <= 0) {
    throw new Error('--iterations must be a positive number')
  }

  args.limit = Math.floor(args.limit)
  args.iterations = Math.floor(args.iterations)

  return args
}

async function runIteration(args, workerSecret, iterationIndex) {
  const endpoint = `${args.baseUrl.replace(/\/$/, '')}/api/index/worker`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${workerSecret}`,
    },
    body: JSON.stringify({ limit: args.limit }),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Worker request failed (${response.status}): ${JSON.stringify(body)}`)
  }

  console.log(`[index-worker] iteration=${iterationIndex} claimed=${body.claimed} processed=${body.processed} failed=${body.failed}`)
  return body
}

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const workerSecret = process.env.INDEX_WORKER_SECRET

  if (!workerSecret) {
    throw new Error('INDEX_WORKER_SECRET env required')
  }

  let totalProcessed = 0
  let totalFailed = 0

  for (let i = 1; i <= args.iterations; i++) {
    const body = await runIteration(args, workerSecret, i)
    totalProcessed += Number(body.processed || 0)
    totalFailed += Number(body.failed || 0)

    if (Number(body.claimed || 0) === 0) {
      console.log('[index-worker] no claimable jobs left, stopping early')
      break
    }
  }

  console.log('[index-worker] summary')
  console.log(`processed=${totalProcessed}`)
  console.log(`failed=${totalFailed}`)
}

run().catch((err) => {
  console.error('[index-worker] fatal:', err.message)
  process.exit(1)
})
