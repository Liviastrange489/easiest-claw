import { useEffect, useState } from "react"
import { Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { setRendererDebugEnabled } from "@/lib/debug"

type DebugStatus = {
  debugEnabled: boolean
  traceEnabled: boolean
  tracePath?: string
  traceWrites?: number
  traceDropped?: number
}

export function DebugConfigPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<DebugStatus>({
    debugEnabled: true,
    traceEnabled: true,
  })

  const loadStatus = async () => {
    setLoading(true)
    try {
      const res = await window.ipc.settingsGetDebug()
      const next = res as DebugStatus
      setStatus({
        debugEnabled: Boolean(next.debugEnabled),
        traceEnabled: Boolean(next.traceEnabled),
        tracePath: next.tracePath,
        traceWrites: next.traceWrites ?? 0,
        traceDropped: next.traceDropped ?? 0,
      })
      setRendererDebugEnabled(Boolean(next.debugEnabled))
    } catch {
      toast.error("读取调试配置失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await window.ipc.settingsSaveDebug({
        debugEnabled: status.debugEnabled,
        traceEnabled: status.traceEnabled,
      })
      const next = res as DebugStatus & { ok?: boolean; error?: string }
      if (next.ok === false) {
        toast.error(next.error ?? "保存失败")
        return
      }
      setStatus((prev) => ({
        ...prev,
        traceEnabled: Boolean(next.traceEnabled),
        tracePath: next.tracePath,
        traceWrites: next.traceWrites ?? prev.traceWrites ?? 0,
        traceDropped: next.traceDropped ?? prev.traceDropped ?? 0,
      }))
      setRendererDebugEnabled(status.debugEnabled)
      toast.success("调试配置已保存")
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Debug 日志</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              控制控制台里的调试输出（如 Gateway/Skills 详细日志）。
            </p>
          </div>
          <Switch
            checked={status.debugEnabled}
            onCheckedChange={(v) => setStatus((prev) => ({ ...prev, debugEnabled: Boolean(v) }))}
            disabled={loading || saving}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Trace 写盘</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              将调试事件写入 `debug-trace.jsonl`（用于问题排查）。
            </p>
          </div>
          <Switch
            checked={status.traceEnabled}
            onCheckedChange={(v) => setStatus((prev) => ({ ...prev, traceEnabled: Boolean(v) }))}
            disabled={loading || saving}
          />
        </div>
      </div>

      <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-1.5 text-xs text-muted-foreground">
        <p>Trace 文件: {status.tracePath ?? "—"}</p>
        <p>已写入: {status.traceWrites ?? 0}</p>
        <p>已丢弃: {status.traceDropped ?? 0}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={loading || saving} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </Button>
        <Button variant="outline" size="sm" onClick={() => void loadStatus()} disabled={loading || saving}>
          刷新状态
        </Button>
      </div>
    </div>
  )
}

