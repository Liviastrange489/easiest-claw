/**
 * openclaw-paths.ts
 *
 * 统一的 OpenClaw 路径查找和共享常量。
 * bundled-process.ts、update.ts、openclaw-init.ts 均引用此文件，
 * 避免路径逻辑重复。
 */

import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDataDir } from './data-dir'

// ── OpenClaw 目录查找 ───────────────────────────────────────────────────────────

/**
 * 返回可能存在的 openclaw 目录候选列表（按优先级排序）。
 * - 打包版：优先查 dataDir（用户自定义或默认 userData），回退 resources（旧版兼容）
 * - 开发版：build/openclaw/
 */
export function getOpenclawCandidates(): string[] {
  return app.isPackaged
    ? [join(getDataDir(), 'openclaw'), join(process.resourcesPath, 'openclaw')]
    : [join(app.getAppPath(), 'build', 'openclaw')]
}

/**
 * 查找包含 openclaw.mjs 入口的目录。
 * 返回第一个存在入口脚本的候选目录路径，或 null。
 */
export function findOpenclawDir(): string | null {
  for (const dir of getOpenclawCandidates()) {
    if (existsSync(join(dir, 'openclaw.mjs'))) return dir
  }
  return null
}

/**
 * 查找可用的 openclaw 入口脚本（优先 wrapper 入口）。
 * 返回 { openclawDir, entryScript } 或 null。
 */
export function findOpenclawEntry(): { openclawDir: string; entryScript: string } | null {
  for (const openclawDir of getOpenclawCandidates()) {
    const wrapper = join(openclawDir, 'easiest-claw-gateway.mjs')
    const entryScript = existsSync(wrapper) ? wrapper : join(openclawDir, 'openclaw.mjs')
    if (existsSync(entryScript)) return { openclawDir, entryScript }
  }
  return null
}

// ── Node / npm / git 路径 ──────────────────────────────────────────────────────

function getNodeDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'node')
    : join(app.getAppPath(), 'resources', 'node')
}

export function getBundledNodeBin(): string {
  return process.platform === 'win32'
    ? join(getNodeDir(), 'node.exe')
    : join(getNodeDir(), 'node')
}

export function getBundledNpmBin(): string {
  return process.platform === 'win32'
    ? join(getNodeDir(), 'npm.cmd')
    : join(getNodeDir(), 'npm')
}

export function getBundledGitBin(): string | null {
  if (process.platform !== 'win32') return null
  const gitDir = app.isPackaged
    ? join(process.resourcesPath, 'git')
    : join(app.getAppPath(), 'resources', 'git', 'win')
  const gitExe = join(gitDir, 'cmd', 'git.exe')
  return existsSync(gitExe) ? gitExe : null
}

// ── 共享常量 ────────────────────────────────────────────────────────────────────

/** 升级后删除的大型无用包（与 bundle-openclaw.mjs 保持同步） */
export const UNUSED_LARGE_PKGS = [
  'koffi', 'pdfjs-dist', 'node-llama-cpp', '@node-llama-cpp',
  'playwright-core', '@playwright', 'typescript', '@cloudflare',
]

/**
 * easiest-claw-gateway.mjs 包装脚本内容。
 * 在 Windows 上 patch child_process.spawn 等函数加 windowsHide: true，
 * 然后 import 真正的 openclaw.mjs 启动 gateway。
 *
 * 与 bundle-openclaw.mjs 中写入的内容保持同步。
 */
export const EASIEST_CLAW_GATEWAY_SCRIPT = `/**
 * easiest-claw-gateway.mjs — EasiestClaw 包装入口
 * 在 Windows 上 patch child_process，然后启动真正的 OpenClaw Gateway。
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

// openclaw entry.js 的 isMainModule() 通过 argv[1] 或 pm_exec_path 判断主入口。
// easiest-claw-gateway.mjs 不在 ENTRY_WRAPPER_PAIRS 白名单中，需设置 pm_exec_path
// 让 isMainModule 检测通过，否则 entry.js 会跳过执行直接退出（code 0）。
process.env.pm_exec_path = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'entry.js')

if (process.platform === 'win32') {
  const require = createRequire(import.meta.url)
  const cp = require('child_process')

  const _spawn = cp.spawn
  cp.spawn = function (cmd, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = [] }
    return _spawn.call(this, cmd, args, Object.assign({ windowsHide: true }, opts || {}))
  }

  const _spawnSync = cp.spawnSync
  cp.spawnSync = function (cmd, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = [] }
    return _spawnSync.call(this, cmd, args, Object.assign({ windowsHide: true }, opts || {}))
  }

  const _execFile = cp.execFile
  cp.execFile = function (file, args, opts, cb) {
    if (typeof args === 'function') { cb = args; args = []; opts = {} }
    else if (!Array.isArray(args)) { cb = opts; opts = typeof args === 'object' ? args : {}; args = [] }
    else if (typeof opts === 'function') { cb = opts; opts = {} }
    return _execFile.call(this, file, args, Object.assign({ windowsHide: true }, opts || {}), cb)
  }

  const _exec = cp.exec
  cp.exec = function (cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    return _exec.call(this, cmd, Object.assign({ windowsHide: true }, opts || {}), cb)
  }

  const _execSync = cp.execSync
  cp.execSync = function (cmd, opts) {
    return _execSync.call(this, cmd, Object.assign({ windowsHide: true }, opts || {}))
  }
}

await import('./openclaw.mjs')
`
