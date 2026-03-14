#!/usr/bin/env node
/**
 * extract-release-notes.mjs
 *
 * 从 CHANGELOG.md 中提取指定版本的发版说明。
 *
 * 用法：node scripts/extract-release-notes.mjs 0.2.0
 * 输出：该版本的 Markdown 正文（输出到 stdout）
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const version = process.argv[2]
if (!version) {
  console.error('用法: node scripts/extract-release-notes.mjs <version>')
  process.exit(1)
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
const lines = changelog.split('\n')

// 找到 ## [version] 开头的行（转义版本号中所有特殊正则字符）
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startPattern = new RegExp(`^## \\[${escapedVersion}\\]`)
const sectionPattern = /^## \[/

let inSection = false
const result = []

for (const line of lines) {
  if (startPattern.test(line)) {
    inSection = true
    continue // 跳过标题行本身
  }
  if (inSection && sectionPattern.test(line)) {
    break // 遇到下一个版本节，停止
  }
  if (inSection) {
    result.push(line)
  }
}

if (result.length === 0) {
  console.error(`CHANGELOG.md 中找不到版本 ${version} 的内容`)
  process.exit(1)
}

// 去掉首尾空行
const notes = result.join('\n').trim()
process.stdout.write(notes + '\n')
