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
      const splitIndex = trimmed.indexOf('=')
      if (splitIndex <= 0) continue
      const key = trimmed.slice(0, splitIndex).trim()
      let value = trimmed.slice(splitIndex + 1).trim()
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
    dim: 512,
    distance: 'Cosine',
    onDisk: true,
    hnswM: 16,
    efConstruct: 256,
    skipCollection: false,
    skipIndexes: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dim' && argv[i + 1]) args.dim = Number(argv[++i])
    if (token.startsWith('--dim=')) args.dim = Number(token.split('=')[1])
    if (token === '--distance' && argv[i + 1]) args.distance = argv[++i]
    if (token.startsWith('--distance=')) args.distance = token.split('=')[1]
    if (token === '--onDisk' && argv[i + 1]) args.onDisk = argv[++i] === 'true'
    if (token.startsWith('--onDisk=')) args.onDisk = token.split('=')[1] === 'true'
    if (token === '--hnswM' && argv[i + 1]) args.hnswM = Number(argv[++i])
    if (token.startsWith('--hnswM=')) args.hnswM = Number(token.split('=')[1])
    if (token === '--efConstruct' && argv[i + 1]) args.efConstruct = Number(argv[++i])
    if (token.startsWith('--efConstruct=')) args.efConstruct = Number(token.split('=')[1])
    if (token === '--skipCollection') args.skipCollection = true
    if (token === '--skipIndexes') args.skipIndexes = true
  }

  if (!Number.isFinite(args.dim) || args.dim <= 0) {
    throw new Error('--dim must be a positive number')
  }
  if (!Number.isFinite(args.hnswM) || args.hnswM <= 0) {
    throw new Error('--hnswM must be a positive number')
  }
  if (!Number.isFinite(args.efConstruct) || args.efConstruct <= 0) {
    throw new Error('--efConstruct must be a positive number')
  }

  const normalizedDistance = String(args.distance || '').trim()
  const allowed = ['Cosine', 'Dot', 'Euclid', 'Manhattan']
  const matched = allowed.find((d) => d.toLowerCase() === normalizedDistance.toLowerCase())
  if (!matched) {
    throw new Error(`--distance must be one of: ${allowed.join(', ')}`)
  }
  args.distance = matched

  return args
}

function getConfig() {
  const url = process.env.QDRANT_URL
  const apiKey = process.env.QDRANT_API_KEY || null
  const collection = process.env.QDRANT_COLLECTION || 'photopik_faces'
  if (!url) {
    throw new Error('QDRANT_URL env required')
  }
  return {
    url: url.replace(/\/$/, ''),
    apiKey,
    collection,
  }
}

async function request(config, { method, pathName, body, allow404 = false }) {
  const headers = { 'content-type': 'application/json' }
  if (config.apiKey) headers['api-key'] = config.apiKey
  const response = await fetch(`${config.url}${pathName}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 404 && allow404) {
    return { ok: false, status: response.status, payload }
  }
  if (!response.ok) {
    throw new Error(`Qdrant ${method} ${pathName} failed (${response.status}): ${JSON.stringify(payload)}`)
  }
  return { ok: true, status: response.status, payload }
}

async function ensureCollection(config, args) {
  const pathName = `/collections/${config.collection}`
  const existing = await request(config, {
    method: 'GET',
    pathName,
    allow404: true,
  })

  if (!existing.ok) {
    await request(config, {
      method: 'PUT',
      pathName,
      body: {
        vectors: {
          size: args.dim,
          distance: args.distance,
          on_disk: args.onDisk,
        },
        hnsw_config: {
          m: args.hnswM,
          ef_construct: args.efConstruct,
        },
      },
    })
    console.log(`[qdrant-setup] created collection=${config.collection} dim=${args.dim} distance=${args.distance}`)
    return
  }

  const result = existing.payload?.result || {}
  const vectors = result?.config?.params?.vectors
  const currentDim = vectors?.size
  const currentDistance = vectors?.distance
  console.log(`[qdrant-setup] collection exists: ${config.collection}`)
  if (currentDim != null || currentDistance != null) {
    console.log(`[qdrant-setup] current vectors size=${currentDim} distance=${currentDistance}`)
  }
}

async function createPayloadIndex(config, fieldName, fieldSchema) {
  await request(config, {
    method: 'PUT',
    pathName: `/collections/${config.collection}/index`,
    body: {
      field_name: fieldName,
      field_schema: fieldSchema,
    },
  })
  console.log(`[qdrant-setup] ensured payload index: ${fieldName}`)
}

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const config = getConfig()

  if (!args.skipCollection) {
    await ensureCollection(config, args)
  }

  if (!args.skipIndexes) {
    await createPayloadIndex(config, 'eventId', 'keyword')
    await createPayloadIndex(config, 'imageId', 'keyword')
    await createPayloadIndex(config, 'embeddingVersion', 'keyword')
  }

  console.log('[qdrant-setup] done')
}

run().catch((err) => {
  console.error('[qdrant-setup] fatal:', err.message)
  process.exit(1)
})
