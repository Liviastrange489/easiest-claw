import type { IpcMain } from 'electron'
import os from 'os'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync } from 'fs'
import { getRuntime, restartRuntime, stopRuntime } from '../gateway/runtime'
import { patchSettings } from '../gateway/settings'
import {
  GATEWAY_PORT,
  getBundledOpenclaw,
  getBundledNodeBin,
  readGatewayToken,
  writeGatewayConfig,
  forkOpenclawGateway,
  waitForGatewayReady,
  checkPortOpen,
  waitForPortClosed,
  addGatewayLogListener,
  getBundledOpenclawVersion,
  getGatewaySource,
  setGatewaySource,
  isPortConflictPending,
  setPortConflictPending,
  stopGatewayGracefully,
} from '../gateway/bundled-process'
import { extractOpenClawIfNeeded } from '../openclaw-init'
import { getDataDir } from '../lib/data-dir'

// 鈹€鈹€ System environment detection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function getExecutablePath(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'where' : 'which', [cmd], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        // where 鍙兘杩斿洖澶氳锛屽彇绗竴琛?
        resolve(out.trim().split(/\r?\n/)[0].trim())
      } else {
        resolve(null)
      }
    })
    child.on('error', () => resolve(null))
    const timer = setTimeout(() => { try { child.kill() } catch {} resolve(null) }, 3000)
    child.on('close', () => clearTimeout(timer))
  })
}

async function detectSystemNode(): Promise<{ version: string; path: string | null } | null> {
  const [version, execPath] = await Promise.all([
    new Promise<string | null>((resolve) => {
      const child = spawn('node', ['--version'], {
        shell: process.platform === 'win32',
        windowsHide: true,
      })
      let out = ''
      child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
      child.on('error', () => resolve(null))
      const timer = setTimeout(() => { try { child.kill() } catch {} resolve(null) }, 5000)
      child.on('close', () => clearTimeout(timer))
    }),
    getExecutablePath('node'),
  ])
  if (version === null) return null
  return { version, path: execPath }
}

type InstallProgressStatus = 'running' | 'done' | 'error'
type InstallProgressSender = (step: string, status: InstallProgressStatus, detail?: string) => void

async function startBundledGatewayWithProgress(
  send: InstallProgressSender
): Promise<{ ok: true; openclawDir: string; gatewayUrl: string } | { ok: false; error: string }> {
  const bundledOc = getBundledOpenclaw()
  if (!bundledOc) {
    send('init', 'error', 'Bundled openclaw not found (resources/openclaw/openclaw.mjs)')
    return { ok: false, error: 'Bundled openclaw not found' }
  }
  const { openclawDir, entryScript } = bundledOc

  send('init', 'running', 'Preparing Gateway configuration...')
  let token = readGatewayToken()
  if (token) {
    send('init', 'done', 'Using existing Gateway token')
  } else {
    token = crypto.randomBytes(24).toString('hex')
    writeGatewayConfig(token)
    send('init', 'done', 'Generated and saved Gateway token')
  }

  send('start', 'running', 'Starting OpenClaw Gateway...')

  const removeLogListener = addGatewayLogListener((line, isError) => {
    send('start', 'running', `${isError ? '[stderr] ' : ''}${line}`)
  })

  forkOpenclawGateway(entryScript, openclawDir, token, true)

  const started = await waitForGatewayReady(20_000)
  removeLogListener()

  if (!started) {
    send('start', 'error', `Gateway was not ready within 20s (port ${GATEWAY_PORT})`)
    return { ok: false, error: 'Gateway startup timed out. Please try Repair.' }
  }
  send('start', 'done', `Gateway is ready (port ${GATEWAY_PORT})`)

  send('connect', 'running', 'Connecting runtime...')
  const cfg = { url: `ws://localhost:${GATEWAY_PORT}`, token }
  patchSettings({ gateway: cfg })
  setGatewaySource('bundled')
  await restartRuntime()
  send('connect', 'done', `Connected (${cfg.url})`)

  return { ok: true, openclawDir, gatewayUrl: cfg.url }
}

// 鈹€鈹€ IPC handlers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
export const registerEnvHandlers = (ipcMain: IpcMain): void => {

  // 鈹€鈹€ 鐜妫€娴嬶紙骞跺彂鎵ц锛岃緝鎱絾淇℃伅鍏ㄩ潰锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  ipcMain.handle('env:detect', async () => {
    const platform = os.platform()
    const osNames: Record<string, string> = {
      win32: 'Windows', darwin: 'macOS', linux: 'Linux',
    }

    const bundledOc = getBundledOpenclaw()
    const [systemNode, bundledOcVersion] = await Promise.all([
      detectSystemNode(),
      bundledOc ? getBundledOpenclawVersion(bundledOc.openclawDir) : Promise.resolve(undefined as string | null | undefined),
    ])

    const bundledNodeVersion = process.versions.node
    const adapter = getRuntime()
    const openclawRunning = adapter?.getStatus() === 'connected'

    const nodeActiveSource = 'bundled' as const
    const nodeActiveReason = `使用内置 Electron Node.js ${bundledNodeVersion}`

    const gatewaySource = getGatewaySource()
    const portConflictPending = isPortConflictPending()

    let ocActiveSource: 'bundled' | 'external'
    let ocActiveReason: string
    if (gatewaySource === 'external') {
      ocActiveSource = 'external'
      ocActiveReason = '已连接到外部 OpenClaw (直连模式)'
    } else {
      ocActiveSource = 'bundled'
      ocActiveReason = portConflictPending ? '检测到外部 OpenClaw，等待用户决策...' : '使用内置 OpenClaw'
    }

    const actualVersion: string | undefined = bundledOcVersion ?? undefined

    return {
      ok: true as const,
      result: {
        portConflict: portConflictPending,
        os: { platform, name: osNames[platform] ?? platform, release: os.release(), arch: os.arch() },
        node: {
          version: bundledNodeVersion,
          activeSource: nodeActiveSource,
          activeReason: nodeActiveReason,
          system: systemNode
            ? { available: true, version: systemNode.version, path: systemNode.path, satisfies: false }
            : null,
          bundled: { available: true, version: bundledNodeVersion },
        },
        openclaw: {
          version: actualVersion,
          running: openclawRunning,
          canStart: bundledOc !== null,
          system: null,
          bundled: { available: bundledOc !== null, version: bundledOcVersion ?? undefined, path: bundledOc?.openclawDir ?? null },
          activeSource: ocActiveSource,
          activeReason: ocActiveReason,
        },
      },
    }
  })

  // 鈹€鈹€ 鎵嬪姩鍚姩鍐呯疆 openclaw锛圲I 瑙﹀彂锛岀敤浜?gateway 宕╂簝鍚庨噸鍚級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  ipcMain.handle('env:install-openclaw', async (event) => {
    const send = (step: string, status: InstallProgressStatus, detail?: string) => {
      console.log(`[Openclaw:${step}][${status}] ${detail ?? ''}`)
      event.sender.send('env:install-progress', { step, status, detail })
    }

    send('node', 'done', `Electron Node.js ${process.versions.node}`)
    return startBundledGatewayWithProgress(send)
  })

  ipcMain.handle('env:repair-openclaw', async (event) => {
    const send = (step: string, status: InstallProgressStatus, detail?: string) => {
      console.log(`[OpenclawRepair:${step}][${status}] ${detail ?? ''}`)
      event.sender.send('env:install-progress', { step, status, detail })
    }

    send('node', 'done', `Electron Node.js ${process.versions.node}`)
    send('init', 'running', 'Stopping existing Gateway...')

    try { await stopRuntime() } catch {}
    try { await stopGatewayGracefully(8000) } catch {}

    const markerPath = join(getDataDir(), '.openclaw-version')
    try { rmSync(markerPath, { force: true }) } catch {}

    send('init', 'running', 'Re-extracting bundled OpenClaw...')
    try {
      await extractOpenClawIfNeeded(null, process.resourcesPath)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      send('init', 'error', `Re-extract failed: ${msg}`)
      return { ok: false, error: `Re-extract failed: ${msg}` }
    }

    send('init', 'done', 'Reinstall completed')
    return startBundledGatewayWithProgress(send)
  })

  // Port conflict handling
  ipcMain.handle('gateway:resolve-conflict', async (_, { action }: { action: 'connect' | 'stop-and-start' }) => {
    setPortConflictPending(false)

    if (action === 'connect') {
      // 鐩磋繛锛氫娇鐢ㄥ閮?OpenClaw锛宼oken 宸插湪 autoSpawn 鏃跺啓鍏?settings
      setGatewaySource('external')
      await restartRuntime()
      return { ok: true }
    }

    // stop-and-start锛氬仠姝㈠閮紝鍚姩鍐呯疆
    const bundledOc = getBundledOpenclaw()
    if (!bundledOc) return { ok: false, error: '找不到内置 openclaw' }
    const { openclawDir, entryScript } = bundledOc

    const nodeBin = getBundledNodeBin()
    console.log('[ResolveConflict] stopping external gateway...')
    await new Promise<void>((resolve) => {
      const child = spawn(nodeBin, [entryScript, 'gateway', 'stop'], {
        cwd: openclawDir,
        windowsHide: true,
      })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
      setTimeout(() => { try { child.kill() } catch {} resolve() }, 8000)
    })

    const portClosed = await waitForPortClosed(GATEWAY_PORT, 10_000)
    if (!portClosed) {
      console.warn('[ResolveConflict] port not released within 10s, retrying...')
      await new Promise(r => setTimeout(r, 2000))
    }

    let token = readGatewayToken()
    if (!token) {
      token = crypto.randomBytes(24).toString('hex')
      writeGatewayConfig(token)
    }

    patchSettings({ gateway: { url: `ws://localhost:${GATEWAY_PORT}`, token } })
    forkOpenclawGateway(entryScript, openclawDir, token, true)

    const ready = await checkPortOpen(GATEWAY_PORT, 30_000)
    if (ready) {
      setGatewaySource('bundled')
      console.log('[ResolveConflict] bundled gateway ready')
    } else {
      console.warn('[ResolveConflict] bundled gateway not ready within 30s')
    }

    await restartRuntime()
    return { ok: ready }
  })
}

