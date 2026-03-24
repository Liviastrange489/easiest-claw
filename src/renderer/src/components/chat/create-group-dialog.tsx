

import { FolderOpen, Search, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/i18n"
import { getAgentAvatarUrl } from "@/lib/avatar"
import {
  getStrategyDescription,
  getStrategyLabel,
  STRATEGY_OPTIONS,
} from "@/lib/orchestration/labels"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app-context"
import type { A2AMasterMode, Conversation, OrchestrationStrategy } from "@/types"

interface CreateGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateGroupDialog({ open, onOpenChange }: CreateGroupDialogProps) {
  const { dispatch, state } = useApp()
  const { locale, t } = useI18n()
  const mainAgentId = state.mainAgentId
  const [name, setName] = useState("")
  const [purpose, setPurpose] = useState("")
  const [workspacePath, setWorkspacePath] = useState("")
  const [selectedIds, setSelectedIds] = useState<string[]>(mainAgentId ? [mainAgentId] : [])
  const [search, setSearch] = useState("")
  const [strategy, setStrategy] = useState<OrchestrationStrategy>(mainAgentId ? "coordinator" : "skill-match")
  const [coordinatorId, setCoordinatorId] = useState(mainAgentId ?? "")
  const [maxResponders, setMaxResponders] = useState(2)
  const [strictRoleMatch, setStrictRoleMatch] = useState(true)
  const [masterMode, setMasterMode] = useState<A2AMasterMode>("embedded-master")
  const requiresCoordinator =
    strategy === "coordinator" || (strategy === "a2a" && masterMode === "openclaw-coordinator")
  const isEmbeddedA2A = strategy === "a2a" && masterMode === "embedded-master"
  const resolvedCoordinatorId =
    (coordinatorId && selectedIds.includes(coordinatorId) ? coordinatorId : "")
    || (mainAgentId && selectedIds.includes(mainAgentId) ? mainAgentId : "")
    || selectedIds[0]
    || ""

  // When dialog opens, ensure main agent is pre-selected as coordinator
  useEffect(() => {
    if (open && mainAgentId) {
      setSelectedIds((prev) => prev.includes(mainAgentId) ? prev : [mainAgentId, ...prev])
      setCoordinatorId(mainAgentId)
      setStrategy("coordinator")
    }
  }, [open, mainAgentId])

  const categories: Record<string, typeof state.agents> = {}
  for (const agent of state.agents) {
    const category = agent.category || "OpenClaw"
    if (!categories[category]) categories[category] = []
    categories[category].push(agent)
  }

  const toggle = (id: string) => {
    if (id === mainAgentId && !isEmbeddedA2A) return
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    )
  }

  const remove = (id: string) => {
    if (id === mainAgentId && !isEmbeddedA2A) return
    setSelectedIds((prev) => prev.filter((value) => value !== id))
  }

  const resetForm = () => {
    setName("")
    setPurpose("")
    setWorkspacePath("")
    setSelectedIds(mainAgentId ? [mainAgentId] : [])
    setSearch("")
    setStrategy(mainAgentId ? "coordinator" : "skill-match")
    setCoordinatorId(mainAgentId ?? "")
    setMaxResponders(2)
    setStrictRoleMatch(true)
    setMasterMode("embedded-master")
  }

  const handleCreate = () => {
    if (!name.trim() || selectedIds.length === 0) return

    const newConversation: Conversation = {
      id: `conv-${Date.now()}`,
      type: "group",
      name: name.trim(),
      avatar: "GR",
      purpose: purpose.trim() || undefined,
      workspacePath: workspacePath.trim() || undefined,
      members: ["user", ...selectedIds],
      orchestration: {
        strategy,
        ...(
          requiresCoordinator && resolvedCoordinatorId
            ? { coordinatorId: resolvedCoordinatorId }
            : {}
        ),
        ...(strategy === "a2a" ? { a2aStrictRoleMatch: strictRoleMatch, masterMode } : {}),
        ...(strategy === "skill-match" ? { maxResponders } : {}),
        ...(strategy === "round-robin" ? { roundRobinIndex: 0 } : {}),
      },
      lastMessage: t("groupCreate.createdMessage"),
      lastMessageTime: t("common.justNow"),
      unreadCount: 0,
    }

    dispatch({ type: "CREATE_CONVERSATION", payload: newConversation })
    onOpenChange(false)
    resetForm()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen)
        if (!nextOpen) resetForm()
      }}
    >
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle>{t("groupCreate.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("groupCreate.nameLabel")}</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value.slice(0, 30))}
                placeholder={t("groupCreate.namePlaceholder")}
              />
              <p className="text-xs text-muted-foreground text-right">{name.length}/30</p>
            </div>

            <div className="space-y-2">
              <Label>{t("groupCreate.purposeLabel")}</Label>
              <Textarea
                value={purpose}
                onChange={(event) => setPurpose(event.target.value.slice(0, 200))}
                placeholder={t("groupCreate.purposePlaceholder")}
                rows={2}
              />
              <p className="text-xs text-muted-foreground">{t("groupCreate.purposeHelper")}</p>
            </div>

            <div className="space-y-2">
              <Label>{t("groupCreate.workspaceLabel")}</Label>
              <div className="flex gap-2">
                <Input
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder={t("groupCreate.workspacePlaceholder")}
                  className="flex-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const result = await window.ipc.selectDirectory()
                    if (result.ok && result.path) setWorkspacePath(result.path)
                  }}
                  className="shrink-0 flex items-center gap-1.5 px-3 rounded-md border text-xs text-muted-foreground hover:bg-accent transition-colors"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("groupCreate.browsePath")}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t("groupCreate.workspaceHelper")}</p>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>{t("groupCreate.strategyLabel")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {STRATEGY_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setStrategy(option)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
                      strategy === option
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent"
                    )}
                  >
                    <span className="text-sm font-medium">{getStrategyLabel(option, t)}</span>
                    <span className="text-[11px] text-muted-foreground leading-tight">
                      {getStrategyDescription(option, t)}
                    </span>
                  </button>
                ))}
              </div>

              {strategy === "skill-match" && (
                <div className="flex items-center gap-2 pt-1">
                  <Label className="text-xs whitespace-nowrap">{t("groupCreate.maxResponders")}</Label>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3].map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setMaxResponders(count)}
                        className={cn(
                          "h-7 w-7 rounded-md text-xs font-medium transition-colors",
                          maxResponders === count
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-accent"
                        )}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {strategy === "a2a" && (
                <div className="pt-1 space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    {t("groupCreate.a2aGuide")} <code>A2A -&gt; @Agent: task</code>
                    <code className="mx-1">```a2a ... ```</code>
                    {` ${t("groupCreate.a2aGuideWith")} `}
                    <code>{`{"to":"Agent","message":"..."}`}</code>. {
                      masterMode === "embedded-master"
                        ? t("groupCreate.a2aGuideTailEmbedded")
                        : t("groupCreate.a2aGuideTailCoordinator")
                    }
                  </p>
                  <div className="space-y-1.5 rounded-md border p-2">
                    <p className="text-[11px] font-medium">{t("groupCreate.masterModeLabel")}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMasterMode("embedded-master")}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                          masterMode === "embedded-master"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-accent"
                        )}
                      >
                        {t("groupCreate.masterModeEmbedded")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMasterMode("openclaw-coordinator")}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                          masterMode === "openclaw-coordinator"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-accent"
                        )}
                      >
                        {t("groupCreate.masterModeOpenclawCoordinator")}
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {t("groupCreate.masterModeHint")}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                    <Checkbox
                      checked={strictRoleMatch}
                      onCheckedChange={(checked) => setStrictRoleMatch(checked === true)}
                    />
                    <span>
                      {t("groupCreate.strictRoleRouting")}
                    </span>
                  </label>
                </div>
              )}

              {requiresCoordinator && selectedIds.length > 0 && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs">
                    {strategy === "a2a" ? t("groupCreate.a2aCoordinatorLabel") : t("groupCreate.coordinatorLabel")}
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedIds.map((id) => {
                      const agent = state.agents.find((item) => item.id === id)
                      if (!agent) return null

                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setCoordinatorId(id)}
                          className={cn(
                            "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                            coordinatorId === id
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted hover:bg-accent"
                          )}
                        >
                          {agent.name}
                        </button>
                      )
                    })}
                  </div>
                  {!resolvedCoordinatorId && (
                    <p className="text-[11px] text-amber-600">
                      {strategy === "a2a" ? t("groupCreate.a2aCoordinatorRequired") : t("groupCreate.coordinatorRequired")}
                    </p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("groupCreate.selectMembers")}</Label>
                <span className="text-xs text-muted-foreground">
                  {t("common.selectedCount", { count: selectedIds.length })}
                </span>
              </div>

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t("groupCreate.searchMembers")}
                  className="pl-8"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>

              <ScrollArea className="h-[200px]">
                {Object.entries(categories).map(([category, agents]) => {
                  const filtered = agents.filter(
                    (agent) => agent.name.includes(search) || agent.role.includes(search)
                  )
                  if (filtered.length === 0) return null

                  return (
                    <div key={category} className="mb-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1 px-1">
                        {category}
                      </p>
                      {filtered.map((agent) => (
                        <label
                          key={agent.id}
                          className={cn(
                            "flex items-center gap-3 p-2 rounded-lg cursor-pointer",
                            agent.id === mainAgentId ? "opacity-80" : "hover:bg-accent"
                          )}
                        >
                          <Checkbox
                            checked={selectedIds.includes(agent.id)}
                            onCheckedChange={() => toggle(agent.id)}
                            disabled={agent.id === mainAgentId && !isEmbeddedA2A}
                          />
                          <Avatar className="h-8 w-8 shrink-0">
                            <AvatarImage src={getAgentAvatarUrl(agent.id)} alt={agent.name} />
                            <AvatarFallback className="text-xs bg-blue-100 text-blue-700">
                              {agent.avatar}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium">{agent.name}</span>
                            {agent.id === mainAgentId && requiresCoordinator && (
                              <span className="ml-2 text-[11px] text-primary font-medium">{t("groupCreate.mainAgent")}</span>
                            )}
                            {agent.id === mainAgentId && isEmbeddedA2A && (
                              <span className="text-xs text-muted-foreground ml-2">{t("groupCreate.seedAgent")}</span>
                            )}
                            {agent.id !== mainAgentId && (
                              <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground truncate max-w-[140px] shrink-0">
                            {agent.skills.join(locale.startsWith("zh") ? "、" : ", ")}
                          </span>
                        </label>
                      ))}
                    </div>
                  )
                })}
              </ScrollArea>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-6 py-4 space-y-3">
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selectedIds.map((id) => {
                const agent = Object.values(categories)
                  .flat()
                  .find((item) => item.id === id)

                return (
                  <Badge key={id} variant="secondary" className={cn("gap-1", id !== mainAgentId && "pr-1")}>
                    {agent?.name}
                    {requiresCoordinator && id === resolvedCoordinatorId ? (
                      <span className="text-[10px] text-primary ml-0.5">{t("groupCreate.coordinator")}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => remove(id)}
                        disabled={id === mainAgentId && !isEmbeddedA2A}
                        className="hover:bg-muted-foreground/20 rounded-full p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                )
              })}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !name.trim() ||
                selectedIds.length === 0 ||
                (requiresCoordinator && !resolvedCoordinatorId)
              }
            >
              {t("groupCreate.createWithCount", { count: selectedIds.length })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
