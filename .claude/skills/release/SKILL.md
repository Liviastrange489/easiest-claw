---
description: 发版助手。自动分析改动、生成 CHANGELOG 条目、处理版本号（0.x.x 自动标记为测试版），最终执行 release 脚本完成发版。
---

# Release Skill

当用户执行 `/release` 时，按以下步骤执行。**每一步都要实际操作，不要只描述。**

---

## Step 1 — 分析改动

并行执行：
1. 用 Bash 运行 `git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline` 获取自上次 tag 以来的所有 commit
2. 用 Bash 运行 `git diff --stat HEAD` 查看未提交的文件改动
3. 读取 `CHANGELOG.md`，提取 `## [Unreleased]` 区块的当前内容

---

## Step 2 — 生成 CHANGELOG 条目

根据 Step 1 的结果判断：

**如果 `[Unreleased]` 已有实质内容**（非空占位符），直接展示给用户确认，跳到 Step 3。

**如果 `[Unreleased]` 是空的**，根据 commits 和文件改动自动归类生成条目：
- `feat:` / 新增功能 → `### 新增`
- `fix:` / 修复问题 → `### 修复`
- `refactor:` / `chore:` / `ci:` / 工程改动 → `### 变更`
- 删除功能 → `### 移除`

生成后展示完整草稿，询问用户是否需要修改，确认后写入 `CHANGELOG.md` 的 `[Unreleased]` 区块。

---

## Step 3 — 确定版本号

读取 `package.json` 的当前 `version`，结合改动类型建议下一个版本号：

| 改动类型 | 规则 | 示例 |
|---|---|---|
| 仅 Bug 修复 | 修订号 +1 | `0.0.1` → `0.0.2` |
| 新增功能 | 次版本号 +1，修订号归零 | `0.0.1` → `0.1.0` |
| 破坏性变更 | 主版本号 +1 | `0.x.x` → `1.0.0` |

版本号支持 `-beta` / `-alpha` / `-rc.1` 等后缀（如 `0.1.0-beta`）。

**测试版判断**：版本号主版本为 0（即 `0.x.x`）或包含 `-`（如 `0.1.0-beta`）时，在 GitHub Release 上自动标记为"预发布/测试版"（CI 已配置，无需手动处理）。

向用户展示建议版本号，等待确认或让用户输入自定义版本号。

---

## Step 4 — 执行发版

用户确认版本号后，用 Bash 运行：

```bash
pnpm run release <version>
```

实时展示输出。命令完成后提示用户前往 GitHub 查看 Release。

---

## 注意事项

- 发版前如果工作区有未提交改动，`release.mjs` 会报错拒绝执行，提示用户先 commit 或 stash
- `CHANGELOG.md` 格式必须保持 `## [Unreleased]` 标题，否则脚本无法提取
- 版本号格式必须是 `x.x.x`（三段数字），不带 `v` 前缀
