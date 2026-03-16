/**
 * data-dir.ts
 *
 * 统一获取应用数据目录。
 * 支持用户在设置中自定义数据存储位置（避免 C 盘空间不足）。
 *
 * settings.json 本身始终存在 Electron 默认 userData 下（否则找不到自定义路径配置），
 * 但 openclaw 解压目录、版本标记等大文件数据可存放到自定义位置。
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 返回数据存储目录。
 * 优先读取 settings.json 中的 customDataDir，未设置或目录不可用时回退到 Electron 默认 userData。
 */
export function getDataDir(): string {
  const defaultDir = app.getPath('userData')
  try {
    const settingsFile = path.join(defaultDir, 'settings.json')
    if (!fs.existsSync(settingsFile)) return defaultDir
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
    const custom = settings.customDataDir
    if (typeof custom !== 'string' || !custom.trim()) return defaultDir
    const resolved = path.resolve(custom.trim())
    // 目录必须存在（用户选择时已创建）
    if (!fs.existsSync(resolved)) return defaultDir
    return resolved
  } catch {
    return defaultDir
  }
}
