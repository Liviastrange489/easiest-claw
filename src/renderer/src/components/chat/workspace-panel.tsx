import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderClosed,
  FolderOpen,
  Loader2,
  PanelRightClose,
  RefreshCw,
  Save,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"
import { AGENT_FILE_NAMES } from "@/lib/agents/agentFiles"

// ── Types ────────────────────────────────────────────────────────────────────

type TreeNode = {
  name: string
  type: "file" | "dir"
  path: string
  size?: number
  updatedAtMs?: number
  children?: TreeNode[]
}

type SelectedFile = {
  path: string
  name: string
  isBootstrap: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BOOTSTRAP_SET = new Set<string>(AGENT_FILE_NAMES)

function isBootstrapFile(node: TreeNode): boolean {
  // Root-level files matching bootstrap names
  return node.type === "file" && !node.path.includes("/") && BOOTSTRAP_SET.has(node.name)
}

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
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loadingList, setLoadingList] = useState(false)

  // selection
  const [selected, setSelected] = useState<SelectedFile | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  // preview state
  const [content, setContent] = useState("")
  const [editContent, setEditContent] = useState("")
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  // ── Load file tree ──────────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    if (!agentId) return
    setLoadingList(true)
    try {
      const res = await window.ipc.agentsWorkspaceTree({ agentId })
      if (res.ok) {
        setWorkspace(res.workspace ?? "")
        setTree(res.tree ?? [])
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
      setFileError(null)
      loadFiles()
    }
  }, [open, agentId, loadFiles])

  // ── Load file content ───────────────────────────────────────────────────

  const loadFileContent = useCallback(
    async (file: SelectedFile) => {
      setLoadingFile(true)
      setDirty(false)
      setFileError(null)
      try {
        if (file.isBootstrap) {
          // Bootstrap files: use gateway API (supports editing)
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
          // Other files: use filesystem read (read-only)
          const res = await window.ipc.agentsWorkspaceRead({ agentId, filePath: file.path })
          if (res.ok) {
            if (res.binary) {
              setContent("")
              setEditContent("")
              setFileError(t("workspace.binaryFile"))
            } else if (res.tooLarge) {
              setContent("")
              setEditContent("")
              setFileError(t("workspace.fileTooLarge"))
            } else {
              const c = res.content ?? ""
              setContent(c)
              setEditContent(c)
            }
          } else {
            setContent("")
            setEditContent("")
            setFileError(res.error ?? "")
          }
        }
      } finally {
        setLoadingFile(false)
      }
    },
    [agentId, t]
  )

  const handleSelectFile = (file: SelectedFile) => {
    setSelected(file)
    loadFileContent(file)
  }

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }

  // ── Save ────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selected || !selected.isBootstrap) return
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

  // ── Render tree recursively ─────────────────────────────────────────────

  const renderTree = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.type === "dir") {
        const isExpanded = expandedDirs.has(node.path)
        return (
          <div key={node.path}>
            <button
              className={cn(
                "w-full flex items-center gap-1.5 py-1.5 text-left hover:bg-accent/50 transition-colors",
              )}
              style={{ paddingLeft: `${depth * 16 + 12}px`, paddingRight: "12px" }}
              onClick={() => toggleDir(node.path)}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              ) : (
                <FolderClosed className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              )}
              <span className="text-xs font-medium truncate">{node.name}/</span>
              {node.children && node.children.length > 0 && (
                <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                  {node.children.length}
                </span>
              )}
            </button>
            {isExpanded && node.children && renderTree(node.children, depth + 1)}
          </div>
        )
      }

      const bootstrap = isBootstrapFile(node)
      const isSelected =
        selected?.path === node.path
      return (
        <div
          key={node.path}
          className={cn(
            "group flex items-center gap-1.5 py-1.5 transition-colors",
            isSelected ? "bg-accent" : "hover:bg-accent/50"
          )}
          style={{ paddingLeft: `${depth * 16 + 12}px`, paddingRight: "12px" }}
        >
          <button
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
            onClick={() =>
              handleSelectFile({ path: node.path, name: node.name, isBootstrap: bootstrap })
            }
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono truncate flex-1">{node.name}</span>
          </button>
          {node.size != null && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {formatSize(node.size)}
            </span>
          )}
          <button
            className="h-5 w-5 shrink-0 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent transition-all"
            title={t("workspace.openExternal")}
            onClick={(e) => {
              e.stopPropagation()
              window.ipc.agentsWorkspaceOpen({ agentId, filePath: node.path })
            }}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      )
    })

  return (
    <div
      className="border-l flex flex-col bg-background shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: open ? 360 : 0, borderLeftWidth: open ? 1 : 0 }}
    >
    <div className="w-[360px] flex flex-col h-full shrink-0">
      {/* Header */}
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
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={() => loadFiles()}
            disabled={loadingList}
            title={t("workspace.refresh")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loadingList && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
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
          {/* File tree — scrollable, max ~40% height */}
          <ScrollArea className="shrink-0 max-h-[40%] border-b">
            <div className="py-1">
              {tree.length > 0 ? (
                renderTree(tree, 0)
              ) : (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {t("workspace.emptyFile")}
                </p>
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
                    {selected.path}
                  </span>
                </div>
                {selected.isBootstrap ? (
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
                ) : (
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
              ) : fileError ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <p className="text-xs">{fileError}</p>
                </div>
              ) : (
                <Textarea
                  className="flex-1 resize-none font-mono text-xs min-h-0 border-0 rounded-none focus-visible:ring-0"
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value)
                    setDirty(e.target.value !== content)
                  }}
                  readOnly={!selected.isBootstrap}
                  placeholder={
                    selected.isBootstrap
                      ? t("workspace.emptyFile")
                      : t("workspace.readonly")
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
