/**
 * 品牌与应用标识统一配置（单一入口）
 *
 * 修改后执行：`npm run brand`
 * 会同步更新：
 * - src/shared/branding.ts
 * - resources/installer.nsh
 * - package.json (description / build.appId / build.productName)
 * - src/renderer/index.html (<title>)
 *
 * 推荐长期策略：
 * - appName：可中文（用户可见）
 * - appId / productName / firewallRuleName：建议英文 ASCII（系统字段）
 */

export default {
  // 用户可见名称（界面标题、欢迎文案等）
  appName: 'EasiestClaw',

  // 系统字段：建议保持英文 ASCII
  appId: 'com.EasiestClaw.desktop',
  productName: 'EasiestClaw',
  description: 'EasiestClaw',
  firewallRuleName: 'EasiestClaw',
}
