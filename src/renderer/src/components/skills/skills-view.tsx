import { useCallback, useEffect, useRef, useState } from "react"
import {
  Download,
  ExternalLink,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  Star,
  Store,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"
import { toast } from "sonner"

// ── Types ────────────────────────────────────────────────────────────────

interface Skill {
  name: string
  description?: string
  version?: string
  enabled: boolean
  source?: string
  install?: { id?: string; kind: string; label?: string }[]
}

interface MarketplaceSkill {
  slug: string
  displayName?: string
  name?: string
  description?: string
  version?: string
  score?: number
  author?: string
  downloads?: number
  stars?: number
  versions?: number
  changelog?: string
  license?: string
  createdAt?: number
}

type Tab = "installed" | "marketplace"

// ── Helpers ──────────────────────────────────────────────────────────────

export function parseSkillsResult(raw: unknown): Skill[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.skills)
      ? (raw as { skills: unknown[] }).skills
      : []

  return list
    .map((s) => {
      if (typeof s === "string") return { name: s, enabled: true }
      const sk = s as Record<string, unknown>
      return {
        name: typeof sk.name === "string" ? sk.name : "",
        description: typeof sk.description === "string" ? sk.description : undefined,
        version: typeof sk.version === "string" ? sk.version : undefined,
        enabled: typeof sk.enabled === "boolean" ? sk.enabled : true,
        source: typeof sk.source === "string" ? sk.source : undefined,
        install: Array.isArray(sk.install) ? (sk.install as Skill["install"]) : undefined,
      }
    })
    .filter((s) => s.name)
}

function parseMarketplaceItems(raw: unknown[]): MarketplaceSkill[] {
  return raw
    .map((item) => {
      const r = item as Record<string, unknown>
      const stats = r.stats as Record<string, unknown> | undefined
      const latestVersion = r.latestVersion as Record<string, unknown> | undefined
      return {
        slug: typeof r.slug === "string" ? r.slug : "",
        displayName: typeof r.displayName === "string" ? r.displayName : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        description:
          typeof r.description === "string"
            ? r.description
            : typeof r.summary === "string"
              ? r.summary
              : undefined,
        version:
          typeof r.version === "string"
            ? r.version
            : typeof latestVersion?.version === "string"
              ? latestVersion.version
              : undefined,
        score: typeof r.score === "number" ? r.score : undefined,
        author: typeof r.author === "string" ? r.author : undefined,
        downloads:
          typeof r.downloads === "number"
            ? r.downloads
            : typeof stats?.downloads === "number"
              ? stats.downloads
              : undefined,
        stars: typeof stats?.stars === "number" ? stats.stars : undefined,
        versions: typeof stats?.versions === "number" ? stats.versions : undefined,
        changelog: typeof latestVersion?.changelog === "string" ? latestVersion.changelog : undefined,
        license: typeof latestVersion?.license === "string" ? latestVersion.license : undefined,
        createdAt: typeof r.createdAt === "number" ? r.createdAt : undefined,
      }
    })
    .filter((s) => s.slug)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

// ── Main Component ───────────────────────────────────────────────────────

export function SkillsView() {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>("installed")

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
      {/* Page Header */}
      <div
        className="shrink-0 flex items-center px-8 py-5 border-b bg-background"
        style={{
          WebkitAppRegion: "drag",
          ...(window.ipc.platform !== "darwin" ? { paddingRight: "154px" } : {}),
        } as React.CSSProperties}
      >
        <div
          className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10 shrink-0"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <Puzzle className="h-5 w-5 text-primary" />
        </div>
        <div className="ml-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <h1 className="text-lg font-semibold">{t("skills.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("skills.subtitle")}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 px-8 pt-4 pb-0">
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
          <button
            onClick={() => setTab("installed")}
            className={cn(
              "px-4 py-1.5 text-sm rounded-md transition-colors",
              tab === "installed"
                ? "bg-background text-foreground shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("skills.tabInstalled")}
          </button>
          <button
            onClick={() => setTab("marketplace")}
            className={cn(
              "px-4 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5",
              tab === "marketplace"
                ? "bg-background text-foreground shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Store className="h-3.5 w-3.5" />
            {t("skills.tabMarketplace")}
          </button>
        </div>
      </div>

      {/* Tab Content — both always mounted, hidden via CSS to avoid refetch */}
      <div
        className="flex-1 overflow-y-auto px-8 py-6"
        style={{ display: tab === "installed" ? undefined : "none" }}
      >
        <div className="max-w-2xl mx-auto">
          <InstalledTab />
        </div>
      </div>
      <MarketplaceTab hidden={tab !== "marketplace"} />
    </div>
  )
}

// ── Installed Skills Tab ─────────────────────────────────────────────────

function InstalledTab() {
  const { t } = useI18n()
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const loadSkills = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.ipc.skillsList()
      if (result.ok) {
        setSkills(parseSkillsResult(result.result))
      } else {
        setError((result as { ok: false; error: string }).error)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSkills()
  }, [])

  const handleToggle = async (name: string, enabled: boolean) => {
    setToggling(name)
    const prev = skills
    setSkills(skills.map((s) => (s.name === name ? { ...s, enabled } : s)))
    try {
      const result = await window.ipc.skillsToggle(name, enabled)
      if (!(result as { ok: boolean }).ok) {
        setSkills(prev)
        toast.error((result as { ok: false; error: string }).error ?? t("skills.installFailed"))
      }
    } catch {
      setSkills(prev)
      toast.error(t("skills.installFailed"))
    } finally {
      setToggling(null)
    }
  }

  if (error) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        <p className="mb-3">{error}</p>
        <Button size="sm" variant="outline" onClick={loadSkills}>
          {t("skills.retry")}
        </Button>
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("skills.installed")}</h2>
        <button
          onClick={loadSkills}
          disabled={loading}
          className="ml-auto text-muted-foreground/50 hover:text-foreground transition-colors disabled:pointer-events-none"
          title={t("skills.refresh")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("skills.loading")}
        </div>
      ) : skills.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">
          {t("skills.noSkills")}
        </p>
      ) : (
        <div className="space-y-0">
          {skills.map((skill, i) => (
            <div key={skill.name}>
              {i > 0 && <Separator className="my-2.5 opacity-40" />}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{skill.name}</span>
                    {skill.version && (
                      <span className="text-[10px] text-muted-foreground">v{skill.version}</span>
                    )}
                    {skill.source && (
                      <span className="text-[10px] text-muted-foreground/50">{skill.source}</span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{skill.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleToggle(skill.name, !skill.enabled)}
                  disabled={toggling === skill.name}
                  className={cn(
                    "shrink-0 w-9 h-5 rounded-full transition-colors relative",
                    skill.enabled ? "bg-primary" : "bg-muted-foreground/30",
                    toggling === skill.name && "opacity-50 cursor-not-allowed"
                  )}
                  title={skill.enabled ? t("skills.disable") : t("skills.enable")}
                >
                  <span
                    className={cn(
                      "absolute top-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200",
                      skill.enabled ? "left-[18px]" : "left-[2px]"
                    )}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Marketplace Tab ──────────────────────────────────────────────────────

function MarketplaceTab({ hidden }: { hidden?: boolean }) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<MarketplaceSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [detailSkill, setDetailSkill] = useState<MarketplaceSkill | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadingMoreRef = useRef(false)

  // Load installed skill names for "installed" badge
  useEffect(() => {
    window.ipc.skillsList().then((res) => {
      if (res.ok) {
        const skills = parseSkillsResult(res.result)
        setInstalledNames(new Set(skills.map((s) => s.name)))
      }
    })
  }, [])

  // Auto-load popular skills on mount
  const loadExplore = useCallback(async () => {
    setLoading(true)
    setError(null)
    setIsSearchMode(false)
    setNextCursor(null)
    try {
      const res = await window.ipc.clawHubExplore(30)
      console.log('[Skills] explore result:', JSON.stringify(res).slice(0, 300))
      if (res.ok) {
        const items = parseMarketplaceItems(res.items ?? [])
        console.log('[Skills] parsed items:', items.length)
        setResults(items)
        setNextCursor(res.nextCursor ?? null)
      } else {
        setError((res as { ok: false; error: string }).error)
      }
    } catch (e) {
      console.error('[Skills] explore error:', e)
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadExplore()
  }, [loadExplore])

  // Load more for infinite scroll (explore mode only)
  const loadMore = useCallback(async () => {
    if (!nextCursor || isSearchMode || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await window.ipc.clawHubExplore(30, nextCursor)
      if (res.ok) {
        const newItems = parseMarketplaceItems(res.items ?? [])
        setResults((prev) => {
          const existingSlugs = new Set(prev.map((s) => s.slug))
          const unique = newItems.filter((s) => !existingSlugs.has(s.slug))
          return [...prev, ...unique]
        })
        setNextCursor(res.nextCursor ?? null)
      }
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [nextCursor, isSearchMode])

  // Infinite scroll handler
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || !nextCursor || isSearchMode || loadingMoreRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight - scrollTop - clientHeight < 200) {
      loadMore()
    }
  }, [loadMore, nextCursor, isSearchMode])

  const doSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        loadExplore()
        return
      }
      setLoading(true)
      setError(null)
      setIsSearchMode(true)
      setNextCursor(null)
      try {
        const res = await window.ipc.clawHubSearch(q.trim(), 30)
        if (res.ok) {
          setResults(parseMarketplaceItems(res.results ?? []))
        } else {
          setError((res as { ok: false; error: string }).error)
          setResults([])
        }
      } catch (e) {
        setError(String(e))
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [loadExplore]
  )

  const handleInputChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 500)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    }
  }

  const handleInstall = async (skill: MarketplaceSkill, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setInstallingSlug(skill.slug)
    try {
      const res = await window.ipc.clawHubInstall(skill.slug, "clawhub-download")
      if ((res as { ok: boolean }).ok) {
        toast.success(t("skills.installSuccess"))
        setInstalledNames((prev) => new Set([...prev, skill.slug]))
        window.ipc.skillsList().then((listRes) => {
          if (listRes.ok) {
            const skills = parseSkillsResult(listRes.result)
            setInstalledNames(new Set(skills.map((s) => s.name)))
          }
        })
      } else {
        toast.error(`${t("skills.installFailed")}: ${(res as { ok: false; error: string }).error}`)
      }
    } catch (err) {
      toast.error(`${t("skills.installFailed")}: ${String(err)}`)
    } finally {
      setInstallingSlug(null)
    }
  }

  return (
    <div
      className={cn("flex-1 flex flex-col overflow-hidden", hidden && "hidden")}
    >
      {/* Search bar — fixed at top */}
      <div className="shrink-0 px-8 pt-4 pb-2">
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60 pointer-events-none" />
            <Input
              placeholder={t("skills.searchPlaceholder")}
              className="pl-9 h-10"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {loading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
          <button
            onClick={() => { window.ipc.clawHubCacheClear(); loadExplore() }}
            disabled={loading}
            className="shrink-0 h-10 w-10 flex items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:pointer-events-none disabled:opacity-50"
            title={t("skills.refresh")}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Scrollable results area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-8 pb-6"
        onScroll={handleScroll}
      >
        <div className="max-w-2xl mx-auto space-y-3">
          {/* Section header */}
          {!loading && !error && results.length > 0 && (
            <div className="flex items-center justify-between pt-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {isSearchMode
                  ? `${t("skills.searchPlaceholder").replace("...", "")} "${query}"`
                  : t("skills.explore")}
              </h3>
              <Button
                variant="link"
                size="sm"
                className="text-[10px] h-auto p-0 text-muted-foreground/60"
                onClick={() => window.open("https://clawhub.ai", "_blank")}
              >
                <ExternalLink className="h-3 w-3 mr-0.5" />
                {t("skills.openClawHub")}
              </Button>
            </div>
          )}

          {/* Error */}
          {error && (
            <Card className="p-4 text-center text-sm text-muted-foreground">
              <p>{t("skills.marketplaceError")}</p>
              <p className="text-xs mt-1 opacity-70">{error}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={loadExplore}>
                {t("skills.retry")}
              </Button>
            </Card>
          )}

          {/* Loading skeleton — initial load */}
          {loading && (
            <div className="space-y-2 pt-2">
              {[...Array(8)].map((_, i) => (
                <Card key={i} className="p-4 animate-pulse">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-40 bg-muted rounded" />
                      <div className="h-3 w-24 bg-muted/60 rounded" />
                      <div className="h-3 w-full bg-muted/40 rounded" />
                    </div>
                    <div className="h-7 w-16 bg-muted rounded" />
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* No results after search */}
          {!loading && !error && isSearchMode && results.length === 0 && (
            <Card className="p-8 text-center">
              <Search className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t("skills.noResults")}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">{t("skills.tryOther")}</p>
            </Card>
          )}

          {/* Results list */}
          {!loading &&
            results.map((skill) => {
              const isInstalled = installedNames.has(skill.slug)
              const isInstalling = installingSlug === skill.slug
              return (
                <Card
                  key={skill.slug}
                  className="p-4 cursor-pointer hover:bg-accent/30 transition-colors"
                  onClick={() => setDetailSkill(skill)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">
                          {skill.displayName || skill.name || skill.slug}
                        </span>
                        {skill.version && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            v{skill.version}
                          </span>
                        )}
                        {skill.score != null && (
                          <span className="text-[10px] text-muted-foreground/60">
                            {t("skills.score")}: {(skill.score * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground/80 mt-0.5">{skill.slug}</p>
                      {skill.description && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                          {skill.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/50">
                        {skill.downloads != null && (
                          <span>
                            {skill.downloads.toLocaleString()} {t("skills.downloads")}
                          </span>
                        )}
                        {skill.stars != null && skill.stars > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Star className="h-2.5 w-2.5" />
                            {skill.stars.toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {isInstalled ? (
                        <Badge
                          variant="secondary"
                          className="text-[10px] bg-green-500/10 text-green-600 border-green-200"
                        >
                          {t("skills.installed_badge")}
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          disabled={isInstalling}
                          onClick={(e) => handleInstall(skill, e)}
                        >
                          {isInstalling ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t("skills.installing")}
                            </>
                          ) : (
                            <>
                              <Download className="h-3 w-3" />
                              {t("skills.install")}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              )
            })}

          {/* Load more spinner */}
          {loadingMore && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* End of list indicator */}
          {!loading && !loadingMore && !isSearchMode && results.length > 0 && !nextCursor && (
            <p className="text-center text-[10px] text-muted-foreground/40 py-4">
              — {t("skills.noResults").replace(/^.*$/, "·")} —
            </p>
          )}
        </div>
      </div>

      {/* Skill Detail Dialog */}
      <SkillDetailDialog
        skill={detailSkill}
        onClose={() => setDetailSkill(null)}
        isInstalled={detailSkill ? installedNames.has(detailSkill.slug) : false}
        isInstalling={detailSkill ? installingSlug === detailSkill.slug : false}
        onInstall={() => detailSkill && handleInstall(detailSkill)}
      />
    </div>
  )
}

// ── Skill Detail Dialog ──────────────────────────────────────────────────

function SkillDetailDialog({
  skill,
  onClose,
  isInstalled,
  isInstalling,
  onInstall,
}: {
  skill: MarketplaceSkill | null
  onClose: () => void
  isInstalled: boolean
  isInstalling: boolean
  onInstall: () => void
}) {
  const { t } = useI18n()

  return (
    <Dialog open={!!skill} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden"
      >
        {skill && (
          <>
            {/* Header */}
            <div className="shrink-0 px-5 pt-5 pb-4 space-y-3">
              <div className="min-w-0">
                <DialogTitle className="text-base font-semibold leading-tight">
                  {skill.displayName || skill.name || skill.slug}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  {skill.slug}
                </DialogDescription>
              </div>

              {/* Install / Installed button */}
              <div>
                {!isInstalled ? (
                  <Button
                    size="sm"
                    className="w-full gap-1.5"
                    disabled={isInstalling}
                    onClick={onInstall}
                  >
                    {isInstalling ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("skills.installing")}
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        {t("skills.install")}
                      </>
                    )}
                  </Button>
                ) : (
                  <Badge
                    variant="secondary"
                    className="text-xs bg-green-500/10 text-green-600 border-green-200 w-full justify-center py-1.5"
                  >
                    {t("skills.installed_badge")}
                  </Badge>
                )}
              </div>
            </div>

            {/* Body — scrollable */}
            <div className="flex-1 overflow-y-auto border-t">
              <div className="px-5 py-4 space-y-4">
                {/* Description */}
                {skill.description && (
                  <p className="text-sm text-foreground/80 leading-relaxed">{skill.description}</p>
                )}

                {/* Stats row */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  {skill.version && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      v{skill.version}
                    </Badge>
                  )}
                  {skill.license && <span>{skill.license}</span>}
                  {skill.downloads != null && (
                    <span className="flex items-center gap-1">
                      <Download className="h-3 w-3" />
                      {skill.downloads.toLocaleString()}
                    </span>
                  )}
                  {skill.stars != null && skill.stars > 0 && (
                    <span className="flex items-center gap-1">
                      <Star className="h-3 w-3" />
                      {skill.stars.toLocaleString()}
                    </span>
                  )}
                  {skill.versions != null && (
                    <span>
                      {skill.versions} {skill.versions === 1 ? "version" : "versions"}
                    </span>
                  )}
                  {skill.createdAt && <span>{formatDate(skill.createdAt)}</span>}
                </div>

                {/* Changelog */}
                {skill.changelog && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                      {t("skills.changelog")}
                    </h4>
                    <div className="text-xs text-foreground/70 whitespace-pre-wrap bg-muted/40 rounded-lg p-3 leading-relaxed">
                      {skill.changelog}
                    </div>
                  </div>
                )}

                {/* Open in browser link */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs gap-1.5"
                  onClick={() =>
                    window.open(`https://clawhub.ai/skills/${skill.slug}`, "_blank")
                  }
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("skills.viewOnClawHub")}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
