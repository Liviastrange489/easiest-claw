

import { useEffect } from "react"
import logoPng from "@resources/icon.png"
import { Bug, Loader2, Wifi, WifiOff } from "lucide-react"
import { APP_NAME } from "@shared/branding"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"
import { useApp } from "@/store/app-context"
import { useConnectionSummary } from "@/hooks/use-openclaw"
import { APP_VERSION, BUG_FEEDBACK_URL } from "@/lib/app-meta"
import { buttonVariants } from "@/components/ui/button"

const connectionColors: Record<string, string> = {
  connected: "text-green-600",
  connecting: "text-yellow-600",
  disconnected: "text-muted-foreground",
  error: "text-destructive",
}

interface TopNavProps {
  // reserved for future use
}

export function TopNav(_props: TopNavProps) {
  const { state } = useApp()
  const { t } = useI18n()
  const { summary, loadSummary } = useConnectionSummary()
  const connStatus = (state as { connectionStatus?: string }).connectionStatus ?? "disconnected"
  const connectionLabels: Record<string, string> = {
    connected: t("topNav.connection.connected"),
    connecting: t("topNav.connection.connecting"),
    disconnected: t("topNav.connection.disconnected"),
    error: t("topNav.connection.error"),
  }
  const connInfo = {
    label: connectionLabels[connStatus] ?? connectionLabels.disconnected,
    color: connectionColors[connStatus] ?? connectionColors.disconnected,
  }
  const versionLabel = summary?.version ? `OpenClaw v${summary.version}` : null

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  return (
    <header className="flex h-14 items-center border-b bg-background px-4 gap-4">
      <div className="flex items-center">
        <img src={logoPng} alt={APP_NAME} className="h-8 w-auto" />
      </div>

      {/* 连接状态 */}
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs rounded-md px-2 py-1",
          connInfo.color
        )}
      >
        {connStatus === "connecting" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : connStatus === "connected" ? (
          <Wifi className="h-3.5 w-3.5" />
        ) : (
          <WifiOff className="h-3.5 w-3.5" />
        )}
        <span>{connInfo.label}</span>
        {versionLabel ? (
          <span className="text-muted-foreground">{versionLabel}</span>
        ) : null}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1 shrink-0">
        <span className="text-sm text-muted-foreground">
          v{APP_VERSION}
        </span>
        {BUG_FEEDBACK_URL ? (
          <a
            href={BUG_FEEDBACK_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "h-8 text-muted-foreground"
            )}
          >
            <Bug className="h-4 w-4" />
            <span>{t("header.bugFeedback")}</span>
          </a>
        ) : null}
      </div>
    </header>
  )
}
