import { existsSync } from "node:fs"
import { execSync } from "node:child_process"

if (!existsSync(".git")) {
  process.exit(0)
}

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" })
  console.log("[prepare] Git hooks path set to .githooks")
} catch {
  console.warn("[prepare] Skip git hooks setup (git not available)")
}
