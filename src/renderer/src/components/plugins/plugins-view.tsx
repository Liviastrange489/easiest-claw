import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Package, Puzzle, RefreshCw, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"

// ── Types ────────────────────────────────────────────────────────────────────

interface PluginInfo {
  id: string
  name?: string
  version?: string
  description?: string
  kind?: string
  origin: "bundled" | "installed" | "load-path"
  enabled: boolean
  source?: string
  installPath?: string
}

// ── Main View ────────────────────────────────────────────────────────────────

export function PluginsView() {
  const { t } = useI18n()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [uninstallTarget, setUninstallTarget] = useState<PluginInfo | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.ipc.pluginsList() as { ok: boolean; plugins?: PluginInfo[]; error?: string }
      if (res.ok && res.plugins) {
        setPlugins(res.plugins)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const filtered = useMemo(() => {
    if (!search.trim()) return plugins
    const q = search.toLowerCase()
    return plugins.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q),
    )
  }, [plugins, search])

  const handleUninstall = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      const res = await window.ipc.pluginsUninstall({ pluginId: uninstallTarget.id }) as {
        ok: boolean; error?: string
      }
      if (res.ok) {
        toast.success(t("plugins.uninstallSuccess", { name: uninstallTarget.name ?? uninstallTarget.id }))
        await loadPlugins()
      } else {
        toast.error(t("plugins.uninstallError", { error: res.error ?? "Unknown" }))
      }
    } finally {
      setUninstalling(false)
      setUninstallTarget(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border/50 shrink-0">
        <Puzzle className="h-5 w-5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold">{t("plugins.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("plugins.description")}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadPlugins} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Search */}
      <div className="px-5 py-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder={t("plugins.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">{t("plugins.loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Package className="h-10 w-10 mb-3 opacity-40" />
            <span className="text-sm">{t("plugins.empty")}</span>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                onUninstall={() => setUninstallTarget(plugin)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {/* Uninstall confirm dialog */}
      <AlertDialog open={!!uninstallTarget} onOpenChange={(open) => { if (!open) setUninstallTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugins.uninstallConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("plugins.uninstallConfirmDesc", { name: uninstallTarget?.name ?? uninstallTarget?.id ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstalling}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleUninstall} disabled={uninstalling} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {uninstalling ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />{t("plugins.uninstalling")}</>
              ) : (
                t("plugins.uninstall")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Plugin Card ──────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  onUninstall,
  t,
}: {
  plugin: PluginInfo
  onUninstall: () => void
  t: (key: string, params?: Record<string, string>) => string
}) {
  const isBundled = plugin.origin === "bundled"

  const originVariant = isBundled ? "secondary" : plugin.origin === "load-path" ? "outline" : "default"

  return (
    <Card className="p-4 flex items-start gap-3">
      <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Puzzle className="h-4.5 w-4.5 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium truncate">{plugin.name ?? plugin.id}</span>
          {plugin.version && (
            <span className="text-[11px] text-muted-foreground shrink-0">v{plugin.version}</span>
          )}
        </div>

        {plugin.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mb-1.5">{plugin.description}</p>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant={originVariant} className="text-[10px] px-1.5 py-0">
            {t(`plugins.origin.${plugin.origin}`)}
          </Badge>
          {plugin.kind && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {t(`plugins.kind.${plugin.kind}`)}
            </Badge>
          )}
          <Badge
            variant={plugin.enabled ? "default" : "secondary"}
            className={cn(
              "text-[10px] px-1.5 py-0",
              plugin.enabled ? "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/20" : "",
            )}
          >
            {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
          </Badge>
        </div>
      </div>

      {/* Uninstall button — bundled plugins cannot be uninstalled */}
      {isBundled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 opacity-30 cursor-not-allowed" disabled>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("plugins.cannotUninstallBundled")}</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onUninstall}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </Card>
  )
}
