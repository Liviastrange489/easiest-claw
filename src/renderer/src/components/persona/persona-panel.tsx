

import { useCallback, useEffect, useState } from "react"
import {
  FileText,
  Heart,
  Brain,
  User,
  Wrench,
  Clock,
  BookOpen,
  Save,
  Loader2,
  Sparkles,
  Puzzle,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { type AgentFileName } from "@/lib/agents/agentFiles"
import { useAgentFiles } from "@/hooks/use-agent-files"
import { AgentSkillsSection } from "./agent-skills-section"

type FileDescriptor = {
  name: AgentFileName
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

const FILE_DESCRIPTORS: FileDescriptor[] = [
  {
    name: "AGENTS.md",
    label: "员工手册",
    description: "AI 的工作守则",
    icon: FileText,
  },
  {
    name: "SOUL.md",
    label: "灵魂文件",
    description: "AI 的性格和价值观",
    icon: Heart,
  },
  {
    name: "IDENTITY.md",
    label: "身份证",
    description: "AI 的名字和形象",
    icon: User,
  },
  {
    name: "USER.md",
    label: "用户档案",
    description: "记录主人是谁",
    icon: User,
  },
  {
    name: "TOOLS.md",
    label: "工具小本本",
    description: "设备环境记录",
    icon: Wrench,
  },
  {
    name: "HEARTBEAT.md",
    label: "心跳待办",
    description: "定时唤醒 AI 的任务",
    icon: Clock,
  },
  {
    name: "BOOTSTRAP.md",
    label: "引导仪式",
    description: "首次启动初始化脚本",
    icon: Sparkles,
  },
  {
    name: "MEMORY.md",
    label: "长期记忆",
    description: "精华版人生笔记",
    icon: Brain,
  },
]

interface PersonaPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string
  agentName: string
}

export function PersonaPanel({
  open,
  onOpenChange,
  agentId,
  agentName,
}: PersonaPanelProps) {
  const { fileState, loadFile, saveFile, resetFile } = useAgentFiles()
  const [selectedFile, setSelectedFile] = useState<AgentFileName | null>(null)
  const [editContent, setEditContent] = useState("")
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [skillsSelected, setSkillsSelected] = useState(false)

  const handleSelectFile = useCallback(
    (name: AgentFileName) => {
      setSkillsSelected(false)
      setSelectedFile(name)
      setHasUnsavedChanges(false)
      loadFile(agentId, name)
    },
    [agentId, loadFile]
  )

  // 打开时自动加载第一个文件
  useEffect(() => {
    if (open) {
      setSkillsSelected(false)
      handleSelectFile(FILE_DESCRIPTORS[0].name)
    } else {
      setSelectedFile(null)
      setSkillsSelected(false)
      setEditContent("")
      setHasUnsavedChanges(false)
      resetFile()
    }
  }, [open])

  useEffect(() => {
    if (!fileState.loading && selectedFile) {
      setEditContent(fileState.content)
    }
  }, [fileState.loading, fileState.content, selectedFile])

  const handleContentChange = (value: string) => {
    setEditContent(value)
    setHasUnsavedChanges(value !== fileState.content)
  }

  const handleSave = async () => {
    if (!selectedFile) return
    const ok = await saveFile(agentId, selectedFile, editContent)
    if (ok) {
      setHasUnsavedChanges(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl md:max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            {agentName} - 人格面板
          </DialogTitle>
          <DialogDescription>
            查看和编辑 Agent 的核心人格文件
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-3 min-h-[400px] max-h-[60vh]">
          {/* File list - left side */}
          <ScrollArea className="w-48 shrink-0 rounded-md border">
            <div className="p-2 space-y-1">
              {FILE_DESCRIPTORS.map((file) => {
                const Icon = file.icon
                const isSelected = !skillsSelected && selectedFile === file.name
                return (
                  <button
                    key={file.name}
                    onClick={() => handleSelectFile(file.name)}
                    className={cn(
                      "w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      isSelected && "bg-accent text-accent-foreground"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium truncate text-xs">
                        {file.name}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-tight pl-5.5">
                      {file.label}
                    </p>
                  </button>
                )
              })}

              {/* Skills entry */}
              <button
                onClick={() => {
                  setSkillsSelected(true)
                  setSelectedFile(null)
                  setHasUnsavedChanges(false)
                }}
                className={cn(
                  "w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  skillsSelected && "bg-accent text-accent-foreground"
                )}
              >
                <div className="flex items-center gap-2">
                  <Puzzle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium truncate text-xs">技能权限</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground leading-tight pl-5.5">
                  控制可用技能
                </p>
              </button>
            </div>
          </ScrollArea>

          {/* Editor / Skills - right side */}
          {skillsSelected ? (
            <div className="flex-1 flex flex-col min-w-0 rounded-md border overflow-hidden">
              <div className="flex items-center px-3 py-2 border-b bg-muted/30">
                <Puzzle className="h-3.5 w-3.5 text-muted-foreground mr-2" />
                <span className="font-medium text-sm">技能权限</span>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <AgentSkillsSection agentId={agentId} />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-w-0 rounded-md border">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm truncate">
                      {selectedFile}
                    </span>
                    {hasUnsavedChanges && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                        未保存
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!hasUnsavedChanges || fileState.saving}
                    className="h-7 text-xs shrink-0"
                  >
                    {fileState.saving ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Save className="h-3 w-3 mr-1" />
                    )}
                    保存
                  </Button>
                </div>

                {fileState.loading ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    加载中...
                  </div>
                ) : fileState.error ? (
                  <div className="flex-1 flex items-center justify-center text-destructive text-sm px-4 text-center">
                    {fileState.error}
                  </div>
                ) : (
                  <Textarea
                    value={editContent}
                    onChange={(e) => handleContentChange(e.target.value)}
                    className="flex-1 resize-none border-0 rounded-none focus-visible:ring-0 font-mono text-xs leading-relaxed"
                    placeholder="文件内容为空，可以开始编辑..."
                  />
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                加载中...
              </div>
            )}
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
