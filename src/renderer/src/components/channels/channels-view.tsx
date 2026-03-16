import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Eye, EyeOff, Loader2, Radio, Save, Send } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"

// ── Types ────────────────────────────────────────────────────────────────────

type ChannelId = "feishu" | "telegram"

interface ChannelMeta {
  id: ChannelId
  icon: ReactNode
  nameKey: string
  descKey: string
}

/** Feishu / Lark official logo */
const FeishuIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 1224 1024" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M1224.146926 401.768509a50.444385 50.444385 0 0 0-23.813954-38.631991c-6.095363-3.741292-61.752335-36.782364-141.475481-43.949671a317.253146 317.253146 0 0 0-135.884563 16.982943L746.964061 25.579507A50.444385 50.444385 0 0 0 703.077446 0h-418.268027A50.444385 50.444385 0 0 0 248.027055 84.97777c3.236848 3.447033 296.360763 315.739814 426.969683 459.653442-59.734559 55.762064-103.558119 83.800735-127.666331 96.832201l-200.894764-140.823909a50.045034 50.045034 0 0 0-6.97814-4.098606L79.416697 314.205464A50.444385 50.444385 0 0 0 0.744475 364.124387c0.210185 1.177036 20.619142 118.607361 42.036988 237.635091C86.815207 847.297523 91.775572 859.656397 95.054457 867.874628c5.065457 12.611096 14.334613 24.549601 44.895503 44.538188a595.916337 595.916337 0 0 0 69.361029 38.337733c49.519571 23.603769 128.212812 54.437899 221.59798 67.25918a623.009175 623.009175 0 0 0 85.061845 5.948234c131.491697 0 290.055215-44.138837 418.373119-211.404011 73.564728-96.054517 118.250046-163.944252 154.086578-218.592335 44.033745-67.070014 70.622139-107.551633 118.838564-150.177139a50.444385 50.444385 0 0 0 16.877851-42.015969zM673.693591 100.88877L834.443032 384.638437a413.097477 413.097477 0 0 0-63.055481 59.356226c-8.743693 10.04684-17.256183 19.568218-25.579507 28.711263C656.248242 373.961042 497.033151 203.332909 401.188819 100.88877zM305.491617 882.125167c-59.86067-22.594881-102.065806-47.85911-118.523287-59.692523-10.299062-45.610132-39.935138-209.638457-65.829922-355.780044l391.238243 274.270325a48.132351 48.132351 0 0 0 6.725918 3.951477l189.166445 132.689752a398.300458 398.300458 0 0 1-155.410744 44.138837c-97.336645 7.713787-188.262649-17.277202-247.366653-39.577824z m698.654734-343.442189c-34.932737 53.197808-78.398982 119.385045-149.819824 212.496972a503.371908 503.371908 0 0 1-58.641598 64.33761l-158.185184-110.830518c35.31107-23.813953 81.152405-60.070855 135.905581-114.803013a48.342536 48.342536 0 0 0 14.944149-15.154334c18.790533-19.379051 38.568936-40.859952 59.272153-64.694924 57.086229-65.745849 124.009113-96.243683 198.540692-90.673782a247.639894 247.639894 0 0 1 38.589955 6.011289c-28.290893 33.62959-51.936698 69.63427-80.605924 113.3107z" />
  </svg>
)

const CHANNELS: ChannelMeta[] = [
  { id: "feishu", icon: <FeishuIcon className="h-5 w-5" />, nameKey: "channels.feishu.name", descKey: "channels.feishu.desc" },
  { id: "telegram", icon: <Send className="h-5 w-5" />, nameKey: "channels.telegram.name", descKey: "channels.telegram.desc" },
]

type FeishuConfig = {
  enabled?: boolean
  domain?: string
  connectionMode?: string
  dmPolicy?: string
  groupPolicy?: string
  accounts?: Record<string, { appId?: string; appSecret?: string; botName?: string }>
}

type TelegramConfig = {
  enabled?: boolean
  botToken?: string
  dmPolicy?: string
  groupPolicy?: string
  streaming?: string
}

// ── Main View ────────────────────────────────────────────────────────────────

export function ChannelsView() {
  const { t } = useI18n()
  const [selected, setSelected] = useState<ChannelId>("feishu")
  const [allChannels, setAllChannels] = useState<Record<string, Record<string, unknown>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Local form state
  const [feishuForm, setFeishuForm] = useState<FeishuConfig>({})
  const [telegramForm, setTelegramForm] = useState<TelegramConfig>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    window.ipc.channelsGet().then((res) => {
      if (cancelled) return
      const r = res as { ok: boolean; channels?: Record<string, Record<string, unknown>> }
      if (r.ok) {
        const channels = r.channels ?? {}
        setAllChannels(channels)
        // Populate feishu form
        const fs = (channels.feishu ?? {}) as FeishuConfig
        const mainAccount = fs.accounts?.main ?? {}
        setFeishuForm({
          enabled: fs.enabled !== false,
          domain: fs.domain ?? "feishu",
          connectionMode: fs.connectionMode ?? "websocket",
          dmPolicy: fs.dmPolicy ?? "pairing",
          groupPolicy: fs.groupPolicy ?? "allowlist",
          accounts: {
            main: {
              appId: mainAccount.appId ?? "",
              appSecret: mainAccount.appSecret ?? "",
              botName: mainAccount.botName ?? "",
            },
          },
        })
        // Populate telegram form
        const tg = (channels.telegram ?? {}) as TelegramConfig
        setTelegramForm({
          enabled: tg.enabled !== false,
          botToken: tg.botToken ?? "",
          dmPolicy: tg.dmPolicy ?? "pairing",
          groupPolicy: tg.groupPolicy ?? "allowlist",
          streaming: tg.streaming ?? "partial",
        })
      }
    }).catch(() => {
      if (!cancelled) toast.error(t("channels.loadFailed"))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      // Build the config for the selected channel
      let config: Record<string, unknown>
      if (selected === "feishu") {
        const main = feishuForm.accounts?.main ?? {}
        if (!main.appId?.trim()) {
          toast.error(t("channels.feishu.appIdRequired"))
          setSaving(false)
          return
        }
        if (!main.appSecret?.trim()) {
          toast.error(t("channels.feishu.appSecretRequired"))
          setSaving(false)
          return
        }
        // Merge with existing config to preserve fields we don't manage
        const existing = (allChannels.feishu ?? {}) as Record<string, unknown>
        config = {
          ...existing,
          enabled: feishuForm.enabled !== false,
          domain: feishuForm.domain ?? "feishu",
          connectionMode: feishuForm.connectionMode ?? "websocket",
          dmPolicy: feishuForm.dmPolicy ?? "pairing",
          groupPolicy: feishuForm.groupPolicy ?? "allowlist",
          accounts: {
            ...((existing.accounts as Record<string, unknown>) ?? {}),
            main: {
              appId: main.appId!.trim(),
              appSecret: main.appSecret!.trim(),
              ...(main.botName?.trim() ? { botName: main.botName.trim() } : {}),
            },
          },
        }
      } else {
        if (!telegramForm.botToken?.trim()) {
          toast.error(t("channels.telegram.botTokenRequired"))
          setSaving(false)
          return
        }
        const existing = (allChannels.telegram ?? {}) as Record<string, unknown>
        config = {
          ...existing,
          enabled: telegramForm.enabled !== false,
          botToken: telegramForm.botToken!.trim(),
          dmPolicy: telegramForm.dmPolicy ?? "pairing",
          groupPolicy: telegramForm.groupPolicy ?? "allowlist",
          streaming: telegramForm.streaming ?? "partial",
        }
      }

      const res = await window.ipc.channelsSet({ channelId: selected, config })
      const r = res as { ok: boolean; error?: string }
      if (r.ok) {
        toast.success(t("channels.saveSuccess"))
        // Update local cache
        setAllChannels((prev) => ({ ...prev, [selected]: config }))
      } else {
        toast.error(r.error ?? t("channels.saveFailed"))
      }
    } catch {
      toast.error(t("channels.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const isEnabled = (id: ChannelId) => {
    const ch = allChannels[id] as { enabled?: boolean } | undefined
    return ch?.enabled === true
  }

  const isConfigured = (id: ChannelId) => {
    if (id === "feishu") {
      const fs = allChannels.feishu as FeishuConfig | undefined
      return !!fs?.accounts?.main?.appId
    }
    const tg = allChannels.telegram as TelegramConfig | undefined
    return !!tg?.botToken
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
      {/* Page Header */}
      <div
        className="shrink-0 flex items-center gap-3 px-8 py-5 border-b bg-background"
        style={{
          WebkitAppRegion: "drag",
          ...(window.ipc.platform !== "darwin" && { paddingRight: "154px" }),
        } as React.CSSProperties}
      >
        <div
          className="flex items-center gap-3"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Radio className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">{t("channels.title")}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{t("channels.description")}</p>
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t("channels.loading")}</span>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left: Channel list */}
          <div className="w-[200px] shrink-0 border-r bg-background overflow-y-auto py-2">
            {CHANNELS.map((ch) => (
              <button
                key={ch.id}
                className={cn(
                  "w-full flex items-center gap-2.5 px-4 py-3 text-left transition-colors",
                  selected === ch.id ? "bg-accent" : "hover:bg-accent/50",
                )}
                onClick={() => setSelected(ch.id)}
              >
                <span className="text-lg shrink-0 flex items-center justify-center w-6 h-6">{ch.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{t(ch.nameKey)}</span>
                    {isConfigured(ch.id) && (
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full shrink-0",
                          isEnabled(ch.id) ? "bg-green-500" : "bg-muted-foreground/40",
                        )}
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{t(ch.descKey)}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Right: Config form */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {selected === "feishu" ? (
              <FeishuConfigForm
                value={feishuForm}
                onChange={setFeishuForm}
                saving={saving}
                onSave={handleSave}
              />
            ) : (
              <TelegramConfigForm
                value={telegramForm}
                onChange={setTelegramForm}
                saving={saving}
                onSave={handleSave}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shared form components ───────────────────────────────────────────────────

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  )
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm font-mono pr-9"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

function PolicySelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: (key: string) => string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="pairing">{t("channels.policy.pairing")}</SelectItem>
        <SelectItem value="open">{t("channels.policy.open")}</SelectItem>
        <SelectItem value="allowlist">{t("channels.policy.allowlist")}</SelectItem>
        <SelectItem value="disabled">{t("channels.policy.disabled")}</SelectItem>
      </SelectContent>
    </Select>
  )
}

// ── Feishu Config Form ───────────────────────────────────────────────────────

function FeishuConfigForm({
  value,
  onChange,
  saving,
  onSave,
}: {
  value: FeishuConfig
  onChange: (v: FeishuConfig) => void
  saving: boolean
  onSave: () => void
}) {
  const { t } = useI18n()
  const main = value.accounts?.main ?? {}

  const updateMain = (patch: Partial<typeof main>) => {
    onChange({
      ...value,
      accounts: {
        ...value.accounts,
        main: { ...main, ...patch },
      },
    })
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* Header with switch */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl"><FeishuIcon className="h-6 w-6" /></span>
          <h2 className="text-base font-semibold">{t("channels.feishu.name")}</h2>
          {main.appId && (
            <Badge variant={value.enabled !== false ? "default" : "secondary"} className="text-[10px] px-1.5 h-4">
              {value.enabled !== false ? t("channels.enabled") : t("channels.disabled")}
            </Badge>
          )}
        </div>
        <Switch
          checked={value.enabled !== false}
          onCheckedChange={(checked) => onChange({ ...value, enabled: checked })}
        />
      </div>

      {/* Required fields */}
      <FormSection title={t("channels.requiredFields")}>
        <FormField label="App ID" required>
          <Input
            value={main.appId ?? ""}
            onChange={(e) => updateMain({ appId: e.target.value })}
            placeholder="cli_a1b2c3d4e5f6"
            className="h-8 text-sm font-mono"
          />
        </FormField>

        <FormField label="App Secret" required>
          <PasswordInput
            value={main.appSecret ?? ""}
            onChange={(v) => updateMain({ appSecret: v })}
            placeholder={t("channels.feishu.appSecretPlaceholder")}
          />
        </FormField>
      </FormSection>

      <p className="text-[11px] text-muted-foreground">
        {t("channels.feishu.setupHint")}
      </p>

      {/* Optional fields */}
      <FormSection title={t("channels.optionalFields")}>
        <FormField label={t("channels.feishu.botName")}>
          <Input
            value={main.botName ?? ""}
            onChange={(e) => updateMain({ botName: e.target.value })}
            placeholder={t("channels.feishu.botNamePlaceholder")}
            className="h-8 text-sm"
          />
        </FormField>

        <FormField label={t("channels.feishu.domain")}>
          <Select
            value={value.domain ?? "feishu"}
            onValueChange={(v) => onChange({ ...value, domain: v })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="feishu">{t("channels.feishu.domainFeishu")}</SelectItem>
              <SelectItem value="lark">{t("channels.feishu.domainLark")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t("channels.feishu.connectionMode")}>
          <Select
            value={value.connectionMode ?? "websocket"}
            onValueChange={(v) => onChange({ ...value, connectionMode: v })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="websocket">WebSocket</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t("channels.dmPolicy")}>
          <PolicySelect
            value={value.dmPolicy ?? "pairing"}
            onChange={(v) => onChange({ ...value, dmPolicy: v })}
            t={t}
          />
        </FormField>

        <FormField label={t("channels.groupPolicy")}>
          <PolicySelect
            value={value.groupPolicy ?? "allowlist"}
            onChange={(v) => onChange({ ...value, groupPolicy: v })}
            t={t}
          />
        </FormField>
      </FormSection>

      {/* Save button */}
      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={onSave} disabled={saving} className="gap-1.5 text-xs h-8">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {t("channels.save")}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t("channels.restartHint")}</span>
      </div>
    </div>
  )
}

// ── Telegram Config Form ─────────────────────────────────────────────────────

function TelegramConfigForm({
  value,
  onChange,
  saving,
  onSave,
}: {
  value: TelegramConfig
  onChange: (v: TelegramConfig) => void
  saving: boolean
  onSave: () => void
}) {
  const { t } = useI18n()

  return (
    <div className="max-w-lg space-y-6">
      {/* Header with switch */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl"><Send className="h-6 w-6" /></span>
          <h2 className="text-base font-semibold">{t("channels.telegram.name")}</h2>
          {value.botToken && (
            <Badge variant={value.enabled !== false ? "default" : "secondary"} className="text-[10px] px-1.5 h-4">
              {value.enabled !== false ? t("channels.enabled") : t("channels.disabled")}
            </Badge>
          )}
        </div>
        <Switch
          checked={value.enabled !== false}
          onCheckedChange={(checked) => onChange({ ...value, enabled: checked })}
        />
      </div>

      {/* Required fields */}
      <FormSection title={t("channels.requiredFields")}>
        <FormField label="Bot Token" required>
          <PasswordInput
            value={value.botToken ?? ""}
            onChange={(v) => onChange({ ...value, botToken: v })}
            placeholder="123456789:ABCDefGHiJKlmnoPQRstuvwXYZ"
          />
        </FormField>
      </FormSection>

      <p className="text-[11px] text-muted-foreground">
        {t("channels.telegram.setupHint")}
      </p>

      {/* Optional fields */}
      <FormSection title={t("channels.optionalFields")}>
        <FormField label={t("channels.dmPolicy")}>
          <PolicySelect
            value={value.dmPolicy ?? "pairing"}
            onChange={(v) => onChange({ ...value, dmPolicy: v })}
            t={t}
          />
        </FormField>

        <FormField label={t("channels.groupPolicy")}>
          <PolicySelect
            value={value.groupPolicy ?? "allowlist"}
            onChange={(v) => onChange({ ...value, groupPolicy: v })}
            t={t}
          />
        </FormField>

        <FormField label={t("channels.telegram.streaming")}>
          <Select
            value={value.streaming ?? "partial"}
            onValueChange={(v) => onChange({ ...value, streaming: v })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("channels.telegram.streamingOff")}</SelectItem>
              <SelectItem value="partial">{t("channels.telegram.streamingPartial")}</SelectItem>
              <SelectItem value="block">{t("channels.telegram.streamingBlock")}</SelectItem>
              <SelectItem value="progress">{t("channels.telegram.streamingProgress")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </FormSection>

      {/* Save button */}
      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={onSave} disabled={saving} className="gap-1.5 text-xs h-8">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {t("channels.save")}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t("channels.restartHint")}</span>
      </div>
    </div>
  )
}
