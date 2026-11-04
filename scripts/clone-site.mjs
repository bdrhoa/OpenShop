#!/usr/bin/env node
// Clone an OpenShop site (Worker config + KV data) to a new site name.
//
//   npm run clone -- <source-site> <target-site>
//   npm run deploy <target-site>
//
// Copies: toml/<source>.toml -> toml/<target>.toml (new name, KV namespace,
// R2 bucket, SITE_URL), .env.<source> -> .env.<target>, and every KV entry
// (products, collections, pages, theme, store + developer settings including
// the Stripe key). Admin session tokens are not copied, and SITE_URL in the
// copied developer settings is rewritten to the target URL.
//
// Not copied: R2 objects (the new bucket starts empty). Stripe products are
// shared: the clone's products point at the same Stripe product/price ids.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SKIP_KEY_PREFIXES = ['admin_token:']
const DEV_SETTINGS_KEY = 'developer:settings'

function die(msg) { console.error(`❌ ${msg}`); process.exit(1) }

function wrangler(args, opts = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: opts.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

const [source, target] = process.argv.slice(2)
if (!source || !target) die('Usage: npm run clone -- <source-site> <target-site>')
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(target)) {
  die('Target must be lowercase letters, digits and dashes (a valid Worker name)')
}

const srcToml = join('toml', `${source}.toml`)
const dstToml = join('toml', `${target}.toml`)
if (!existsSync(srcToml)) die(`${srcToml} not found`)
if (existsSync(dstToml)) die(`${dstToml} already exists; pick another name or delete it first`)

let toml = readFileSync(srcToml, 'utf8')
const srcName = toml.match(/^name = "([^"]+)"/m)?.[1] || source
const srcKvId = toml.match(/\[\[kv_namespaces\]\][\s\S]*?id = "([^"]+)"/)?.[1]
const srcSiteUrl = toml.match(/^SITE_URL = "([^"]+)"/m)?.[1]
if (!srcKvId) die(`No KV namespace id in ${srcToml}`)

// https://kount-poc-base.bdrhoa.workers.dev -> https://<target>.bdrhoa.workers.dev
const dstSiteUrl = srcSiteUrl
  ? srcSiteUrl.replace(`//${srcName}.`, `//${target}.`)
  : `https://${target}.workers.dev`

console.log(`📋 Cloning ${srcName} -> ${target}`)
console.log(`   URL: ${dstSiteUrl}\n`)

// 1. New KV namespace
const kvTitle = `${target.toUpperCase()}_KV`
console.log(`🗃️  Creating KV namespace ${kvTitle}...`)
let dstKvId
try {
  dstKvId = wrangler(['kv', 'namespace', 'create', kvTitle]).match(/[a-f0-9]{32}/)?.[0]
} catch {
  const list = JSON.parse(wrangler(['kv', 'namespace', 'list'], { quiet: true }))
  dstKvId = list.find((ns) => ns.title === kvTitle)?.id
  if (dstKvId) console.log('   (already existed, reusing it)')
}
if (!dstKvId) die('Could not create or find the KV namespace')

// 2. New (empty) R2 bucket for uploads
const bucket = `${target}-assets`
console.log(`🪣 Creating R2 bucket ${bucket}...`)
try { wrangler(['r2', 'bucket', 'create', bucket], { quiet: true }) } catch { console.log('   (already exists or could not be created; continuing)') }

// 3. Copy KV entries
console.log('📦 Copying KV data...')
const keys = JSON.parse(wrangler(['kv', 'key', 'list', '--namespace-id', srcKvId, '--remote'], { quiet: true }))
const entries = []
for (const { name, expiration, metadata } of keys) {
  if (SKIP_KEY_PREFIXES.some((p) => name.startsWith(p))) continue
  let value = wrangler(['kv', 'key', 'get', name, '--namespace-id', srcKvId, '--remote', '--text'], { quiet: true })
  if (name === DEV_SETTINGS_KEY) {
    try {
      const settings = JSON.parse(value)
      if (settings.SITE_URL) settings.SITE_URL = dstSiteUrl
      value = JSON.stringify(settings)
    } catch { /* leave as-is */ }
  }
  const entry = { key: name, value }
  if (expiration) entry.expiration = expiration
  if (metadata) entry.metadata = metadata
  entries.push(entry)
}
const tmp = mkdtempSync(join(tmpdir(), 'openshop-clone-'))
const bulkFile = join(tmp, 'kv.json')
try {
  writeFileSync(bulkFile, JSON.stringify(entries))
  wrangler(['kv', 'bulk', 'put', bulkFile, '--namespace-id', dstKvId, '--remote'], { quiet: true })
} finally {
  rmSync(tmp, { recursive: true, force: true }) // contains secrets
}
console.log(`   Copied ${entries.length} keys (skipped ${keys.length - entries.length} session tokens)`)

// 4. Site config
toml = toml
  .replace(/^name = "[^"]+"/m, `name = "${target}"`)
  .replace(/(\[\[kv_namespaces\]\][\s\S]*?binding = ")[^"]+(")/, `$1${kvTitle}$2`)
  .replace(/(\[\[kv_namespaces\]\][\s\S]*?id = ")[^"]+(")/, `$1${dstKvId}$2`)
  .replace(/(\[\[r2_buckets\]\][\s\S]*?bucket_name = ")[^"]+(")/, `$1${bucket}$2`)
  .replace(/^SITE_URL = "[^"]+"/m, `SITE_URL = "${dstSiteUrl}"`)
writeFileSync(dstToml, toml)
console.log(`✅ Wrote ${dstToml}`)

const srcEnv = `.env.${source}`
if (existsSync(srcEnv)) {
  const env = readFileSync(srcEnv, 'utf8').replace(/^SITE_URL=.*$/m, `SITE_URL=${dstSiteUrl}`)
  writeFileSync(`.env.${target}`, env)
  console.log(`✅ Wrote .env.${target}`)
}

console.log(`\n🚀 Next: npm run deploy ${target}`)
console.log(`   Then open ${dstSiteUrl} (admin password is the same as ${srcName})`)
