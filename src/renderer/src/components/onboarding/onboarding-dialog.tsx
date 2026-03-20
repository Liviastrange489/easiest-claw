import { useRef, useState } from "react"
import { Camera, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { markOnboardingDone, setUserAvatar, setUserName } from "@/lib/avatar"
import { useI18n } from "@/i18n"
import { APP_NAME } from "@shared/branding"

// ── Offline-friendly preset avatars (emoji + color, rendered via canvas) ──────

const PRESETS = [
  { emoji: "🦊", bg: "#f97316" },
  { emoji: "🐼", bg: "#6b7280" },
  { emoji: "🦁", bg: "#eab308" },
  { emoji: "🐸", bg: "#22c55e" },
  { emoji: "🦄", bg: "#a855f7" },
  { emoji: "🐺", bg: "#3b82f6" },
  { emoji: "🦋", bg: "#ec4899" },
  { emoji: "🐬", bg: "#06b6d4" },
  { emoji: "🦅", bg: "#dc2626" },
  { emoji: "🐉", bg: "#7c3aed" },
]

function emojiToDataUrl(emoji: string, bg: string): string {
  try {
    const size = 150
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext("2d")
    if (!ctx) return ""
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = `${size * 0.52}px serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(emoji, size / 2, size / 2 + size * 0.04)
    return canvas.toDataURL("image/png")
  } catch {
    return ""
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface OnboardingDialogProps {
  open: boolean
  onDone: () => void
}

export function OnboardingDialog({ open, onDone }: OnboardingDialogProps) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [avatarUrl, setAvatarUrl] = useState("")
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const initial = name.trim().charAt(0).toUpperCase() || "?"

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error(t("header.selectImageFile"))
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(t("header.imageSizeLimit"))
      return
    }
    setUploading(true)
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error("read failed"))
        reader.readAsDataURL(file)
      })
      setAvatarUrl(url)
      setSelectedPreset(null)
    } catch {
      toast.error(t("header.networkError"))
    } finally {
      setUploading(false)
    }
  }

  const handlePresetClick = (index: number) => {
    const preset = PRESETS[index]
    const url = emojiToDataUrl(preset.emoji, preset.bg)
    setAvatarUrl(url)
    setSelectedPreset(index)
  }

  const handleDone = () => {
    if (!name.trim()) {
      toast.error(t("onboarding.nameRequired"))
      return
    }
    if (avatarUrl) setUserAvatar(avatarUrl)
    setUserName(name.trim())
    markOnboardingDone()
    onDone()
  }

  const handleSkip = () => {
    markOnboardingDone()
    onDone()
  }

  return (
    <Dialog open={open} onOpenChange={() => {}} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="max-w-sm p-0 overflow-hidden">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Header */}
        <div className="bg-primary/5 px-6 py-6 text-center border-b">
          <div className="text-3xl mb-2">👋</div>
          <h2 className="text-lg font-semibold">{t("onboarding.title", { appName: APP_NAME })}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t("onboarding.subtitle")}</p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Avatar section */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">
              {t("onboarding.avatarSectionTitle")}
            </p>
            <div className="flex items-center gap-4">
              {/* Preview */}
              <div className="relative shrink-0">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={avatarUrl} />
                  <AvatarFallback className="text-xl font-semibold bg-primary/10 text-primary">
                    {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : initial}
                  </AvatarFallback>
                </Avatar>
                <button
                  type="button"
                  className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-background border border-border flex items-center justify-center hover:bg-accent transition-colors"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  <Camera className="h-3 w-3" />
                </button>
              </div>

              {/* Preset grid */}
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handlePresetClick(i)}
                    className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center text-lg transition-all hover:scale-110",
                      selectedPreset === i
                        ? "ring-2 ring-offset-1 ring-primary scale-110"
                        : "opacity-80 hover:opacity-100"
                    )}
                    style={{ backgroundColor: preset.bg }}
                  >
                    {preset.emoji}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Name section */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
              {t("onboarding.nameSectionTitle")}
            </p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("onboarding.namePlaceholder")}
              maxLength={30}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleDone() }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex flex-col gap-2">
          <Button
            className="w-full"
            onClick={handleDone}
            disabled={!name.trim() || uploading}
          >
            {t("onboarding.getStarted")}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
            onClick={handleSkip}
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
