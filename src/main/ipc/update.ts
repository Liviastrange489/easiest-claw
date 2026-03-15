import type { IpcMain } from 'electron'
import fs from 'fs'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import https from 'https'
import http from 'http'
import { spawn } from 'child_process'
import {
  stopGatewayGracefully,
  restartBundledGateway,
  getBundledOpenclawVersion,
  waitForPortClosed,
  GATEWAY_PORT,
} from '../gateway/bundled-process'
import {
  findOpenclawDir,
  getBundledNpmBin,
  getBundledGitBin,
  UNUSED_LARGE_PKGS,
  EASIEST_CLAW_GATEWAY_SCRIPT,
} from '../lib/openclaw-paths'
import { logger } from '../lib/logger'

const REGISTRY = 'https://registry.npmmirror.com'
const REGISTRY_FALLBACK = 'https://registry.npmjs.org'

// ── 路径工具（委托给 lib/openclaw-paths.ts）──────────────────────────────────────
const getOpenclawDir = findOpenclawDir

// ── 版本比较（支持 YYYY.M.D 和 semver，忽略提交哈希后缀）──────────────────────
function parseVersion(v: string): number[] {
  const clean = v.trim().replace(/\s.*$/, '').replace(/^[^0-9]*/, '')
  return clean.split('.').map(s => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n })
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return false
}

// ── npm registry 查询 ─────────────────────────────────────────────────────────
async function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(`${REGISTRY}/openclaw/latest`, { timeout: 10_000 }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        try { resolve((JSON.parse(data) as { version?: string }).version ?? null) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function readCurrentVersion(): Promise<string | null> {
  const dir = getOpenclawDir()
  return dir ? getBundledOpenclawVersion(dir) : null
}

// ── 升级步骤定义（与渲染端 UI 统一）────────────────────────────────────────────
export const UPGRADE_STEPS = ['download', 'install', 'stop', 'migrate', 'start'] as const
export type UpgradeStep = typeof UPGRADE_STEPS[number]
type UpgradeStepStatus = 'pending' | 'running' | 'done' | 'error'

// ── 模块级升级状态（供渲染层挂载时查询，页面切换后恢复）──────────────────────────
const _upgradeState: {
  running: boolean
  steps: Record<string, { status: UpgradeStepStatus; logs: string[] }>
} = { running: false, steps: {} }

for (const s of UPGRADE_STEPS) _upgradeState.steps[s] = { status: 'pending', logs: [] }

function resetUpgradeState(): void {
  _upgradeState.running = true
  for (const s of UPGRADE_STEPS) _upgradeState.steps[s] = { status: 'pending', logs: [] }
}

// ── 进度发送器类型 ─────────────────────────────────────────────────────────────
type ProgressSender = (step: string, status: 'running' | 'done' | 'error', detail?: string) => void

// ── HTTP 下载工具（支持跟随重定向，30s 超时）────────────────────────────────────
function httpGet(url: string, timeout = 30_000): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const req = protocol.get(url, { timeout }, (res) => {
      // 跟随 301/302 重定向
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume() // 丢弃当前响应体
        httpGet(res.headers.location, timeout).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
  })
}

// ── Step 1: 下载 tarball（直接 HTTP，不经过 npm）────────────────────────────────
async function downloadTarball(
  version: string, destFile: string, send: ProgressSender
): Promise<boolean> {
  const urls = [
    `${REGISTRY}/openclaw/-/openclaw-${version}.tgz`,
    `${REGISTRY_FALLBACK}/openclaw/-/openclaw-${version}.tgz`,
  ]

  for (const url of urls) {
    send('download', 'running', `正在下载 ${url}`)
    try {
      const res = await httpGet(url)
      const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10)
      let downloaded = 0

      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(destFile)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (totalBytes > 0) {
            const pct = Math.round((downloaded / totalBytes) * 100)
            send('download', 'running', `下载中... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
          }
        })
        res.pipe(ws)
        ws.on('finish', resolve)
        ws.on('error', reject)
        res.on('error', reject)
      })

      // 验证文件大小合理（至少 1MB）
      const stat = await fs.promises.stat(destFile)
      if (stat.size < 1024 * 1024) {
        send('download', 'running', `文件过小 (${stat.size} bytes)，可能下载失败`)
        continue
      }

      send('download', 'done', `下载完成 (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      send('download', 'running', `${url} 失败: ${msg}，切换到下一个源...`)
      logger.warn(`[Update] download failed from ${url}: ${msg}`)
    }
  }
  return false
}

// ── Step 2: 解压 tarball + 安装依赖到 stagingDir ────────────────────────────────
async function extractAndInstall(
  tarballPath: string, version: string, stagingDir: string,
  openclawDir: string, send: ProgressSender
): Promise<string | null> {
  // 2a. 解压 tarball → stagingDir
  // npm tarball 内部结构是 package/... ，需要 strip 一层
  send('install', 'running', '正在解压 tarball...')

  const npmBin = getBundledNpmBin()
  const nodeBin = dirname(npmBin)
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${nodeBin}${pathSep}${process.env.PATH ?? ''}`,
  }

  // 用 tar 解压（内置 node 自带 tar）
  const tarOk = await new Promise<boolean>((resolve) => {
    const child = spawn('tar', [
      '-xzf', tarballPath,
      '-C', stagingDir,
      '--strip-components=1',
    ], { windowsHide: true, env })
    child.stderr?.on('data', (d: Buffer) => {
      const l = d.toString().trim()
      if (l) send('install', 'running', l)
    })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

  if (!tarOk) return 'tarball 解压失败'

  // 验证解压结果
  const pkgPath = join(stagingDir, 'package.json')
  if (!existsSync(pkgPath)) return '解压后找不到 package.json'

  try {
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8')) as { version?: string }
    if (pkg.version !== version) return `版本不匹配：期望 ${version}，实际 ${pkg.version ?? '未知'}`
  } catch {
    return 'package.json 读取失败'
  }

  if (!existsSync(join(stagingDir, 'openclaw.mjs'))) return '找不到 openclaw.mjs 入口文件'

  // 2b. 复用旧版 node_modules（大部分依赖不变，极大加速）
  send('install', 'running', '正在复用已有依赖...')
  const oldModules = join(openclawDir, 'node_modules')
  const newModules = join(stagingDir, 'node_modules')

  if (existsSync(oldModules) && !existsSync(newModules)) {
    // 直接 rename 旧 node_modules 到 staging（同盘，原子操作，瞬间完成）
    // 注意：这里不用 cp，因为 node_modules 通常有上万个文件
    try {
      await fs.promises.rename(oldModules, newModules)
      send('install', 'running', '已复用旧版依赖目录')
    } catch {
      // rename 失败（跨盘等），回退到复制
      send('install', 'running', '复用失败，正在复制依赖...')
      await fs.promises.cp(oldModules, newModules, { recursive: true })
    }
  }

  // 2c. 用 npm install 补装新增/变更的依赖（增量，非全量）
  send('install', 'running', '正在检查并补装依赖...')

  // 写 libsignal-node stub
  const stubDir = join(stagingDir, '_stubs', 'libsignal-node')
  await fs.promises.mkdir(stubDir, { recursive: true })
  await fs.promises.writeFile(join(stubDir, 'package.json'),
    JSON.stringify({ name: 'libsignal-node', version: '5.0.0', main: 'index.js' }))
  await fs.promises.writeFile(join(stubDir, 'index.js'), 'module.exports = {};\n')
  const stubPath = stubDir.replace(/\\/g, '/')

  // 读取 package.json，添加 libsignal-node override
  const pkgContent = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8')) as Record<string, unknown>
  const overrides = { ...((pkgContent.overrides as Record<string, string>) ?? {}), 'libsignal-node': `file:${stubPath}` }
  await fs.promises.writeFile(pkgPath, JSON.stringify({ ...pkgContent, overrides }, null, 2))

  const bundledGit = getBundledGitBin()
  const npmEnv = { ...env }
  if (bundledGit) npmEnv.npm_config_git = bundledGit

  const npmArgs = [
    'install', '--omit=dev', '--omit=peer',
    '--no-audit', '--no-fund', '--ignore-scripts',
    '--prefer-offline',          // 优先用本地缓存
    '--fetch-timeout=30000',     // 单个请求 30s 超时
    '--fetch-retries=1',         // 最多重试 1 次
    '--registry', REGISTRY,
  ]

  const npmOk = await new Promise<boolean>((resolve) => {
    const child = spawn(npmBin, npmArgs, {
      cwd: stagingDir,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: npmEnv,
    })
    child.stdout?.on('data', (d: Buffer) => {
      const l = d.toString().trim()
      if (l) send('install', 'running', l)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const l = d.toString().trim()
      if (l) send('install', 'running', l)
    })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

  if (!npmOk) {
    // npm install 失败不一定致命（旧 node_modules 已复用，可能只差少量新包）
    // 记录日志但不中止，让 gateway 启动时再验证
    send('install', 'running', 'npm install 未完全成功，将尝试继续...')
    logger.warn('[Update] npm install exited with non-zero code, continuing with existing modules')
  }

  // 2d. 删除无用大包（减小体积）
  for (const pkg of UNUSED_LARGE_PKGS) {
    const p = join(newModules, pkg)
    if (existsSync(p)) {
      await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})
    }
  }

  // 清理 stub 目录
  await fs.promises.rm(join(stagingDir, '_stubs'), { recursive: true, force: true }).catch(() => {})

  // 2e. 写入 easiest-claw-gateway.mjs
  await fs.promises.writeFile(join(stagingDir, 'easiest-claw-gateway.mjs'), EASIEST_CLAW_GATEWAY_SCRIPT)

  return null // 成功
}

// ── 回滚：恢复备份并重启旧 Gateway ───────────────────────────────────────────
async function rollback(
  openclawDir: string, backupDir: string, send: ProgressSender
): Promise<void> {
  send('migrate', 'running', '正在回滚...')
  try {
    if (existsSync(openclawDir)) {
      await fs.promises.rm(openclawDir, { recursive: true, force: true })
    }
    if (existsSync(backupDir)) {
      await fs.promises.rename(backupDir, openclawDir)
      send('migrate', 'done', '已恢复旧版本')
    } else {
      send('migrate', 'error', '备份不存在，无法回滚')
    }
  } catch (e) {
    send('migrate', 'error', `回滚失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── 主升级函数 ─────────────────────────────────────────────────────────────────
async function performUpgrade(
  version: string, openclawDir: string, send: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  // stagingDir 与 openclawDir 同盘（保证 rename 原子性）
  const stagingDir = openclawDir + '.new'
  const backupDir = openclawDir + '.backup'
  const tarballPath = join(os.tmpdir(), `openclaw-${version}-${Date.now()}.tgz`)
  let gatewayWasStopped = false

  try {
    await fs.promises.mkdir(stagingDir, { recursive: true })

    // 清理残留的上次备份/暂存目录
    if (existsSync(backupDir)) {
      await fs.promises.rm(backupDir, { recursive: true, force: true })
    }

    // ── Step 1: 下载 tarball（gateway 仍在运行，用户无感知）──────────────────────
    send('download', 'running', `正在下载 openclaw@${version}...`)
    const downloadOk = await downloadTarball(version, tarballPath, send)
    if (!downloadOk) {
      send('download', 'error', '下载失败，请检查网络连接')
      return { ok: false, error: '下载失败' }
    }

    // ── Step 2: 解压 + 安装依赖（gateway 仍在运行）──────────────────────────────
    send('install', 'running', '正在安装新版本...')
    const installErr = await extractAndInstall(tarballPath, version, stagingDir, openclawDir, send)
    if (installErr) {
      send('install', 'error', installErr)
      return { ok: false, error: installErr }
    }
    send('install', 'done', '新版本安装完成')

    // ── Step 3: 停止 gateway ────────────────────────────────────────────────────
    send('stop', 'running', '正在停止 Gateway...')
    await stopGatewayGracefully(5_000)
    gatewayWasStopped = true

    const portClosed = await waitForPortClosed(GATEWAY_PORT, 15_000)
    if (!portClosed) {
      send('stop', 'error', 'Gateway 端口未在 15s 内释放，升级中止')
      try { await restartBundledGateway() } catch {}
      return { ok: false, error: 'Gateway 停止超时' }
    }
    send('stop', 'done', 'Gateway 已停止')

    // ── Step 4: 备份 + 迁移（原子 rename，最短停机时间）──────────────────────────
    send('migrate', 'running', '正在迁移文件...')
    await fs.promises.rename(openclawDir, backupDir)
    await fs.promises.rename(stagingDir, openclawDir)
    send('migrate', 'done', '文件迁移完成')

    // ── Step 5: 启动新版本 ─────────────────────────────────────────────────────
    send('start', 'running', '正在启动新版 Gateway...')
    const started = await restartBundledGateway()

    if (!started) {
      send('start', 'error', '新版 Gateway 启动失败，正在回滚...')
      await rollback(openclawDir, backupDir, send)
      try { await restartBundledGateway() } catch {}
      return { ok: false, error: '新版 Gateway 启动失败，已回滚至旧版本' }
    }

    send('start', 'done', `升级完成，当前版本 ${version}`)

    // 异步清理备份
    fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})

    return { ok: true }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    send('install', 'error', `升级异常: ${msg}`)
    logger.error(`[Update] upgrade error: ${err}`)

    if (gatewayWasStopped) {
      await rollback(openclawDir, backupDir, send)
      try { await restartBundledGateway() } catch {}
    }
    return { ok: false, error: msg }

  } finally {
    // 清理临时文件
    fs.promises.unlink(tarballPath).catch(() => {})
    if (existsSync(stagingDir)) {
      fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
export const registerUpdateHandlers = (ipcMain: IpcMain): void => {

  // 检查更新
  ipcMain.handle('openclaw:check-update', async () => {
    const current = await readCurrentVersion()
    const latest = await fetchLatestVersion()
    const hasUpdate = !!(current && latest && isNewer(latest, current))
    return { ok: true, result: { current, latest, hasUpdate } }
  })

  // 执行升级
  ipcMain.handle('openclaw:upgrade', async (event, { version }: { version: string }) => {
    resetUpgradeState()
    const send: ProgressSender = (step, status, detail) => {
      logger.info(`[Update:${step}][${status}] ${detail ?? ''}`)
      // 同步更新模块级状态，供渲染层重新挂载时恢复
      const stepState = _upgradeState.steps[step]
      if (stepState) {
        stepState.status = status
        if (status === 'running' && detail) {
          stepState.logs = [...stepState.logs.slice(-299), detail]
        }
      }
      try { event.sender.send('openclaw:upgrade-progress', { step, status, detail }) } catch {}
    }

    const openclawDir = getOpenclawDir()
    if (!openclawDir) {
      _upgradeState.running = false
      return { ok: false, error: '找不到内置 OpenClaw 目录' }
    }
    const result = await performUpgrade(version, openclawDir, send)
    _upgradeState.running = false
    return result
  })

  // 查询当前升级状态（渲染层切换页面回来时初始化用）
  ipcMain.handle('openclaw:upgrade-state', () => _upgradeState)
}
