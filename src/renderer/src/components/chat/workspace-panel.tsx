import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  PanelRightClose,
  Save,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"

// ── Types ────────────────────────────────────────────────────────────────────

type BootstrapFile = {
  name: string
  path: string
  missing: boolean
  size?: number
  updatedAtMs?: number
}

type MemoryFile = {
  name: string
  size: number
  updatedAtMs: number
}

type SelectedFile =
  | { source: "bootstrap"; name: string }
  | { source: "memory"; name: string }

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── WorkspacePanel ───────────────────────────────────────────────────────────

interface WorkspacePanelProps {
  agentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspacePanel({ agentId, open, onOpenChange }: WorkspacePanelProps) {
  const { t } = useI18n()

  // data
  const [workspace, setWorkspace] = useState("")
  const [bootstrapFiles, setBootstrapFiles] = useState<BootstrapFile[]>([])
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([])
  const [loadingList, setLoadingList] = useState(false)

  // tree state
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  const [selected, setSelected] = useState<SelectedFile | null>(null)

  // preview state
  const [content, setContent] = useState("")
  const [editContent, setEditContent] = useState("")
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const isMemoryFile = selected?.source === "memory"
  const selectedName = selected?.name ?? ""

  // ── Load file list ──────────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    if (!agentId) return
    setLoadingList(true)
    try {
      const [filesRes, memRes] = await Promise.all([
        window.ipc.agentsFilesList({ agentId }),
        window.ipc.agentsMemoryList({ agentId }),
      ])
      if (filesRes.ok) {
        const r = filesRes.result as { workspace?: string; files?: BootstrapFile[] }
        setWorkspace(r.workspace ?? "")
        setBootstrapFiles(r.files ?? [])
      }
      if (memRes.ok) {
        setMemoryFiles((memRes as { ok: true; files: MemoryFile[] }).files ?? [])
      }
    } finally {
      setLoadingList(false)
    }
  }, [agentId])

  useEffect(() => {
    if (open && agentId) {
      setSelected(null)
      setContent("")
      setEditContent("")
      setDirty(false)
      loadFiles()
    }
  }, [open, agentId, loadFiles])

  // ── Load file content ───────────────────────────────────────────────────

  const loadFileContent = useCallback(
    async (file: SelectedFile) => {
      setLoadingFile(true)
      setDirty(false)
      try {
        if (file.source === "bootstrap") {
          const res = await window.ipc.agentsFilesGet({ agentId, name: file.name })
          if (res.ok) {
            const c = (res.result as { file?: { content?: string } })?.file?.content ?? ""
            setContent(c)
            setEditContent(c)
          } else {
            setContent("")
            setEditContent("")
          }
        } else {
          const res = await window.ipc.agentsMemoryGet({ agentId, name: file.name })
          if (res.ok) {
            const c = (res as { ok: true; content?: string }).content ?? ""
            setContent(c)
            setEditContent(c)
          } else {
            setContent("")
            setEditContent("")
          }
        }
      } finally {
        setLoadingFile(false)
      }
    },
    [agentId]
  )

  const handleSelectFile = (file: SelectedFile) => {
    setSelected(file)
    loadFileContent(file)
  }

  // ── Save ────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selected || selected.source !== "bootstrap") return
    setSaving(true)
    try {
      const res = await window.ipc.agentsFilesSet({
        agentId,
        name: selected.name,
        content: editContent,
      })
      if (res.ok) {
        toast.success(`${selected.name} ${t("workspace.saved")}`)
        setContent(editContent)
        setDirty(false)
        loadFiles()
      } else {
        toast.error((res as { error?: string }).error ?? t("workspace.saveFailed"))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="border-l flex flex-col bg-background shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: open ? 360 : 0, borderLeftWidth: open ? 1 : 0 }}
    >
    <div className="w-[360px] flex flex-col h-full shrink-0">
      {/* Header — Windows 下右侧留出窗口控件的空间，避免关闭按钮和系统按钮重叠 */}
      <div
        className="h-12 flex items-center justify-between px-3 border-b shrink-0"
        style={{
          ...(window.ipc.platform !== "darwin" && { paddingRight: "154px" }),
        } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{t("workspace.title")}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => onOpenChange(false)}
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      {/* Workspace path */}
      {workspace && (
        <div className="px-3 py-1.5 border-b">
          <p className="text-[11px] text-muted-foreground font-mono truncate" title={workspace}>
            {workspace}
          </p>
        </div>
      )}

      {loadingList ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t("workspace.loading")}</span>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* File list — scrollable, max ~40% height */}
          <ScrollArea className="shrink-0 max-h-[40%] border-b">
            <div className="py-1">
              {/* Bootstrap files */}
              {bootstrapFiles.map((file) => (
                <TreeFileItem
                  key={file.name}
                  name={file.name}
                  size={file.size}
                  missing={file.missing}
                  isSelected={
                    selected?.source === "bootstrap" && selected.name === file.name
                  }
                  onClick={() =>
                    handleSelectFile({ source: "bootstrap", name: file.name })
                  }
                />
              ))}

              {/* Memory folder */}
              {memoryFiles.length > 0 && (
                <>
                  <button
                    className={cn(
                      "w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent/50 transition-colors"
                    )}
                    onClick={() => setMemoryExpanded((p) => !p)}
                  >
                    {memoryExpanded ? (
                      <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    <span className="text-xs font-medium truncate">memory/</span>
                    <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                      {memoryFiles.length}
                    </span>
                  </button>
                  {memoryExpanded &&
                    memoryFiles.map((file) => (
                      <TreeFileItem
                        key={file.name}
                        name={file.name}
                        size={file.size}
                        indent
                        isSelected={
                          selected?.source === "memory" && selected.name === file.name
                        }
                        onClick={() =>
                          handleSelectFile({ source: "memory", name: file.name })
                        }
                      />
                    ))}
                </>
              )}
            </div>
          </ScrollArea>

          {/* Content preview — fills remaining space */}
          {selected ? (
            <div className="flex-1 flex flex-col min-h-0">
              {/* File header */}
              <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono font-medium truncate">
                    {isMemoryFile ? `memory/${selectedName}` : selectedName}
                  </span>
                </div>
                {!isMemoryFile && (
                  <Button
                    size="sm"
                    className="h-6 gap-1 text-xs px-2"
                    onClick={handleSave}
                    disabled={saving || !dirty}
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    {t("workspace.save")}
                  </Button>
                )}
                {isMemoryFile && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                    {t("workspace.readonly")}
                  </Badge>
                )}
              </div>

              {/* Content */}
              {loadingFile ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                <Textarea
                  className="flex-1 resize-none font-mono text-xs min-h-0 border-0 rounded-none focus-visible:ring-0"
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value)
                    setDirty(e.target.value !== content)
                  }}
                  readOnly={isMemoryFile}
                  placeholder={
                    isMemoryFile
                      ? t("workspace.emptyMemory")
                      : t("workspace.emptyFile")
                  }
                />
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <p className="text-xs">{t("workspace.selectFile")}</p>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  )
}

// ── TreeFileItem ─────────────────────────────────────────────────────────────

function TreeFileItem({
  name,
  size,
  missing,
  indent,
  isSelected,
  onClick,
}: {
  name: string
  size?: number
  missing?: boolean
  indent?: boolean
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-1.5 py-1.5 text-left transition-colors",
        indent ? "px-8" : "px-3",
        isSelected ? "bg-accent" : "hover:bg-accent/50"
      )}
      onClick={onClick}
    >
      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-mono truncate flex-1">{name}</span>
      {missing ? (
        <Badge
          variant="outline"
          className="text-[9px] px-1 py-0 h-3.5 text-yellow-600 border-yellow-400 shrink-0"
        >
          !
        </Badge>
      ) : size != null ? (
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatSize(size)}
        </span>
      ) : null}
    </button>
  )
}
