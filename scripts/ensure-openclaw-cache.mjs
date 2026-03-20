/**
 * ensure-openclaw-cache.mjs
 *
 * 目标：
 * - 为 `npm run dev` 提供稳定的 OpenClaw 运行时缓存
 * - 默认强制使用 npm 来源，避免误走本地 ../openclaw 源
 * - 缓存命中时秒过，只有缺失/来源不符时才触发重建
 *
 * 可选环境变量：
 * - OPENCLAW_DEV_SOURCE=npm|local   (默认 npm)
 * - OPENCLAW_CACHE_REFRESH=1        (强制重建)
 * - npm_config_registry=...         (覆盖安装源)
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..')
const openclawDir = join(root, 'build', 'openclaw')
const metaFile = join(openclawDir, '.bundle-meta.json')

const desiredSourceRaw = String(process.env.OPENCLAW_DEV_SOURCE ?? 'npm').trim().toLowerCase()
const desiredSource = desiredSourceRaw === 'local' ? 'local' : 'npm'
const forceRefresh = ['1', 'true', 'yes'].includes(String(process.env.OPENCLAW_CACHE_REFRESH ?? '').trim().toLowerCase())

function isBundleStructValid() {
  if (!existsSync(openclawDir)) return false
  if (!existsSync(join(openclawDir, 'openclaw.mjs'))) return false
  if (!existsSync(join(openclawDir, 'package.json'))) return false
  if (!existsSync(join(openclawDir, 'dist', 'entry.js'))) return false
  const nodeModulesDir = join(openclawDir, 'node_modules')
  if (!existsSync(nodeModulesDir)) return false
  try {
    return readdirSync(nodeModulesDir).length > 0
  } catch {
    return false
  }
}

function readBundleMeta() {
  if (!existsSync(metaFile)) return null
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8'))
  } catch {
    return null
  }
}

function rebuildCache(reason) {
  console.log(`[openclaw-cache] ${reason}，开始重建缓存（source=${desiredSource}）...`)
  const env = {
    ...process.env,
    OPENCLAW_SOURCE: desiredSource,
    npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmjs.org',
  }
  execSync('node scripts/bundle-openclaw.mjs', {
    cwd: root,
    stdio: 'inherit',
    env,
  })
}

const meta = readBundleMeta()
const structValid = isBundleStructValid()
const sourceMatch = meta?.source === desiredSource

if (forceRefresh) {
  rebuildCache('检测到 OPENCLAW_CACHE_REFRESH=1')
  process.exit(0)
}

if (structValid && sourceMatch) {
  console.log(`[openclaw-cache] 命中缓存（source=${meta.source}, version=${meta.openclawVersion ?? 'unknown'}）`)
  process.exit(0)
}

if (!structValid) {
  rebuildCache('缓存结构不完整')
  process.exit(0)
}

rebuildCache(`缓存来源不匹配（当前=${meta?.source ?? 'unknown'}, 期望=${desiredSource}）`)
