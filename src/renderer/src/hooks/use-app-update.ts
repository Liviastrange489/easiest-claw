/**
 * use-app-update — 监听主进程的应用更新事件，用 Sonner toast 通知用户
 *
 * 事件流：
 *   checking → available / not-available
 *   available → (用户点击下载) → downloading → downloaded
 *   downloaded → (用户点击重启) → quitAndInstall
 */

import { useEffect } from 'react'
import { toast } from 'sonner'

const UPDATE_TOAST_ID = 'app-update'

export function useAppUpdate(): void {
  useEffect(() => {
    const unsubscribe = window.ipc.onAppUpdateStatus((s) => {
      if (s.status === 'available' && s.version) {
        toast.info(`发现新版本 v${s.version}`, {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
          description: '点击下载，下载完成后重启即可更新',
          action: {
            label: '立即下载',
            onClick: () => window.ipc.appDownloadUpdate(),
          },
        })
      }

      if (s.status === 'downloading') {
        const pct = s.progress ?? 0
        toast.loading(`正在下载更新... ${pct}%`, {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
        })
      }

      if (s.status === 'downloaded' && s.version) {
        toast.success(`v${s.version} 已下载完成`, {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
          description: '点击重启以安装新版本',
          action: {
            label: '重启更新',
            onClick: () => window.ipc.appInstallUpdate(),
          },
        })
      }

      if (s.status === 'error') {
        toast.error('检查更新失败', {
          id: UPDATE_TOAST_ID,
          description: s.error,
          duration: 5000,
        })
      }
    })

    return unsubscribe
  }, [])
}
