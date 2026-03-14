#!/usr/bin/env node
/**
 * release.mjs — 一键发布脚本
 *
 * 用法：node scripts/release.mjs <version>
 *       pnpm run release 0.2.0
 *
 * 前置：在 CHANGELOG.md 的 [Unreleased] 区块写好本次更新内容。
 *
 * 步骤：
 *   1. 校验版本号格式
 *   2. 检查 git 工作区是否干净
 *   3. 从 CHANGELOG.md 提取 [Unreleased] 内容（不能为空）
 *   4. 更新 CHANGELOG.md：[Unreleased] → [version] - date，并重置空白模板
 *   5. 更新 package.json version
 *   6. git add + commit + tag + push
 *      → GitHub Actions 触发 build-win / build-mac，自动构建并上传 Release
 *      → CI 从 CHANGELOG.md 提取本版本内容作为 Release 正文
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function run(cmd) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root })
}

// ── 参数校验 ──────────────────────────────────────────────────────────────────
const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
  console.error('用法: pnpm run release <version>  (例如: 0.2.0 或 0.2.0-beta)')
  process.exit(1)
}

// ── 检查工作区是否干净 ────────────────────────────────────────────────────────
const status = execSync('git status --porcelain', { cwd: root }).toString().trim()
if (status) {
  console.error('Git 工作区有未提交的改动，请先 commit 或 stash：')
  console.error(status)
  process.exit(1)
}

// ── 提取 CHANGELOG [Unreleased] 内容 ─────────────────────────────────────────
const changelogPath = resolve(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
const lines = changelog.split('\n')

let unreleasedStart = -1
let unreleasedEnd = -1

for (let i = 0; i < lines.length; i++) {
  if (/^## \[Unreleased\]/i.test(lines[i])) {
    unreleasedStart = i
  } else if (unreleasedStart !== -1 && /^## \[/.test(lines[i])) {
    unreleasedEnd = i
    break
  }
}

if (unreleasedStart === -1) {
  console.error('CHANGELOG.md 中找不到 ## [Unreleased] 区块')
  process.exit(1)
}
if (unreleasedEnd === -1) unreleasedEnd = lines.length

// 提取正文（跳过标题行，去掉首尾空行）
const unreleasedBody = lines
  .slice(unreleasedStart + 1, unreleasedEnd)
  .join('\n')
  .trim()

// 检查是否填写了内容（排除只有占位符 "-" 的情况）
const hasContent = unreleasedBody
  .split('\n')
  .some(l => l.trim() && l.trim() !== '-' && !l.startsWith('#'))

if (!hasContent) {
  console.error('CHANGELOG.md 的 [Unreleased] 区块还没有填写内容，请先写好发版说明再发版。')
  process.exit(1)
}

console.log('✓ 已读取 [Unreleased] 发版说明')

// ── 更新 CHANGELOG.md ─────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10)

const newUnreleased = [
  '## [Unreleased]',
  '',
  '> 在这里写下一个版本的更新内容，发版时会自动提取为 Release 正文。',
  '',
  '### 新增',
  '',
  '-',
  '',
  '### 修复',
  '',
  '-',
  '',
  '### 变更',
  '',
  '-',
  '',
  '---',
  '',
].join('\n')

const versionedSection = [
  `## [${version}] - ${today}`,
  '',
  unreleasedBody,
  '',
  '---',
  '',
].join('\n')

// 替换：[Unreleased] 区块 → 新空白模板 + 当前版本区块
const before = lines.slice(0, unreleasedStart).join('\n')
const after = lines.slice(unreleasedEnd).join('\n')

const newChangelog = [before, newUnreleased, versionedSection, after]
  .join('\n')
  .replace(/\n{3,}/g, '\n\n') // 收拢多余空行

writeFileSync(changelogPath, newChangelog)
console.log(`✓ CHANGELOG.md 已更新：[Unreleased] → [${version}]`)

// ── 更新 package.json version ────────────────────────────────────────────────
const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`✓ package.json: ${prev} → ${version}`)

// ── Git commit + tag + push ───────────────────────────────────────────────────
run('git add CHANGELOG.md package.json')
run(`git commit -m "chore: release v${version}"`)
run(`git tag v${version}`)
run('git push')
run(`git push origin v${version}`)

console.log(`\n🚀 v${version} 已发布！GitHub Actions 将自动构建并上传 Release。`)
