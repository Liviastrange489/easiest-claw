
import { Minus, Square, X } from "lucide-react"
import { useEffect, useState } from "react"
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
import { useI18n } from "@/i18n"

// 悬浮窗口控制按钮，fixed 定位在右上角，自身无背景，不破坏竖向色块连贯性
export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    const unsubscribe = window.ipc.onMaximizedChanged((v) => setIsMaximized(v))
    return () => { unsubscribe() }
  }, [])

  if (window.ipc.platform === "darwin") return null

  return (
    <>
      <div
        className="fixed top-0 right-0 flex items-center z-50"
        style={{ height: "48px", WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
          onClick={() => window.ipc.windowMinimize()}
          title={t("windowControls.minimize")}
        >
          <Minus className="h-3 w-3" />
        </button>
        <button
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
          onClick={() => window.ipc.windowMaximize()}
          title={isMaximized ? t("windowControls.restore") : t("windowControls.maximize")}
        >
          <Square className="h-[11px] w-[11px]" />
        </button>
        <button
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground/50 hover:bg-red-500 hover:text-white transition-colors"
          onClick={() => setCloseConfirmOpen(true)}
          title={t("windowControls.close")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <AlertDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("windowControls.closeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("windowControls.closeConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => window.ipc.windowClose()}
            >
              {t("windowControls.confirmClose")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
