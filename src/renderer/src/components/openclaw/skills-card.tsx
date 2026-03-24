import { useEffect, useState } from "react"
import { Puzzle, Loader2, RefreshCw } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

interface Skill {
  name: string
  description?: string
  version?: string
  enabled: boolean
  source?: string
}

function parseSkillsResult(raw: unknown): Skill[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.skills)
      ? ((raw as { skills: unknown[] }).skills)
      : []

  const parsed = list
    .map((s) => {
      if (typeof s === 'string') return { name: s, enabled: true }
      const sk = s as Record<string, unknown>
      return {
        name: typeof sk.name === 'string' ? sk.name : '',
        description: typeof sk.description === 'string' ? sk.description : undefined,
        version: typeof sk.version === 'string' ? sk.version : undefined,
        enabled: typeof sk.enabled === 'boolean' ? sk.enabled : true,
        source: typeof sk.source === 'string' ? sk.source : undefined,
      }
    })
    .filter((s) => s.name)

  const uniqueByName = new Map<string, Skill>()
  for (const skill of parsed) {
    if (!uniqueByName.has(skill.name)) {
      uniqueByName.set(skill.name, skill)
    }
  }
  return [...uniqueByName.values()]
}

export function SkillsCard() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        toast.error((result as { ok: false; error: string }).error ?? '操作失败')
      }
    } catch {
      setSkills(prev)
      toast.error('操作失败')
    } finally {
      setToggling(null)
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">技能库</h2>
        <button
          onClick={loadSkills}
          disabled={loading}
          className="ml-auto text-muted-foreground/50 hover:text-foreground transition-colors disabled:pointer-events-none"
          title="刷新"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中...
        </div>
      ) : error ? (
        <p className="text-xs text-muted-foreground/70 py-4 text-center">{error}</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">暂无可用技能</p>
      ) : (
        <div className="space-y-0">
          {skills.map((skill, i) => (
            <div key={`${skill.name}:${skill.source ?? ""}:${i}`}>
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

                {/* Toggle switch */}
                <button
                  onClick={() => handleToggle(skill.name, !skill.enabled)}
                  disabled={toggling === skill.name}
                  className={cn(
                    "shrink-0 w-9 h-5 rounded-full transition-colors relative",
                    skill.enabled ? "bg-primary" : "bg-muted-foreground/30",
                    toggling === skill.name && "opacity-50 cursor-not-allowed"
                  )}
                  title={skill.enabled ? "点击禁用" : "点击启用"}
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
