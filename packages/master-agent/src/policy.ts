import type { AssignmentDecision, MasterMember, MasterTaskDomain } from "./types"

const DOMAIN_KEYWORDS: Record<MasterTaskDomain, string[]> = {
  frontend: [
    "frontend",
    "front-end",
    "web",
    "h5",
    "browser",
    "ui",
    "ux",
    "html",
    "css",
    "react",
    "vue",
    "\u524d\u7aef",
    "\u9875\u9762",
    "\u6837\u5f0f",
    "\u7ec4\u4ef6",
  ],
  backend: [
    "backend",
    "back-end",
    "api",
    "server",
    "database",
    "db",
    "sql",
    "node",
    "express",
    "\u540e\u7aef",
    "\u63a5\u53e3",
    "\u670d\u52a1",
    "\u6570\u636e\u5e93",
  ],
  qa: [
    "qa",
    "test",
    "testing",
    "e2e",
    "integration",
    "unit test",
    "sdet",
    "\u6d4b\u8bd5",
    "\u9a8c\u6536",
    "\u56de\u5f52",
  ],
  docs: [
    "doc",
    "docs",
    "documentation",
    "spec",
    "prd",
    "readme",
    "writer",
    "\u6587\u6863",
    "\u9700\u6c42",
    "\u8bf4\u660e",
  ],
  devops: [
    "devops",
    "sre",
    "deploy",
    "deployment",
    "k8s",
    "docker",
    "ci/cd",
    "pipeline",
    "\u8fd0\u7ef4",
    "\u90e8\u7f72",
    "\u53d1\u5e03",
  ],
  research: [
    "research",
    "investigate",
    "analysis",
    "analyst",
    "pm",
    "product manager",
    "explore",
    "\u4ea7\u54c1",
    "\u4ea7\u54c1\u7ecf\u7406",
    "\u8c03\u7814",
    "\u5206\u6790",
    "\u6392\u67e5",
    "\u63a2\u7d22",
  ],
}

function includesAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()))
}

export function detectTaskDomain(text: string): MasterTaskDomain | null {
  const content = text.toLowerCase()
  for (const domain of Object.keys(DOMAIN_KEYWORDS) as MasterTaskDomain[]) {
    if (includesAny(content, DOMAIN_KEYWORDS[domain])) {
      return domain
    }
  }
  return null
}

export function detectMemberDomains(member: MasterMember): MasterTaskDomain[] {
  const content = `${member.name} ${member.role ?? ""} ${(member.skills ?? []).join(" ")}`.toLowerCase()
  const domains: MasterTaskDomain[] = []
  for (const domain of Object.keys(DOMAIN_KEYWORDS) as MasterTaskDomain[]) {
    if (includesAny(content, DOMAIN_KEYWORDS[domain])) {
      domains.push(domain)
    }
  }
  return domains
}

export function evaluateAssignment(params: {
  taskText: string
  member: MasterMember
  strictRoleMatch?: boolean
}): AssignmentDecision {
  const strictRoleMatch = params.strictRoleMatch !== false
  const taskDomain = detectTaskDomain(params.taskText)
  const memberDomains = detectMemberDomains(params.member)

  if (strictRoleMatch && taskDomain) {
    if (memberDomains.length === 0) {
      return {
        allowed: false,
        taskDomain,
        memberDomains,
        reason: `Member has no clear domain labels for ${taskDomain} in strict role routing mode.`,
      }
    }
    if (!memberDomains.includes(taskDomain)) {
      return {
        allowed: false,
        taskDomain,
        memberDomains,
        reason: `Member does not match ${taskDomain} scope in strict role routing mode.`,
      }
    }
  }

  return {
    allowed: true,
    taskDomain,
    memberDomains,
  }
}
