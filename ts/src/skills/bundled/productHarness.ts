import { registerProductBundledSkill } from '../productSkillRegistry.js'

export const PRODUCT_HARNESS_SKILL_NAMES = new Set([
  'update-config',
  'skillify',
  'remember',
  'simplify',
  'venue-daily-review',
  'venue-campaign-planning',
  'customer-follow-up',
  'venue-inspection-followup',
  'staff-performance-coaching',
  'venue-staff-scheduling',
  'venue-content-production',
  'boss-recruiting',
])

const PRODUCT_CONFIG_PROMPT = `# 配置 BilliardBuddy Harness

根据用户要求更新当前项目的 BilliardBuddy 配置。

## 权威位置

- 项目共享配置：\`.BilliardBuddy/settings.json\`
- 当前项目本机配置：\`.BilliardBuddy/settings.local.json\`
- 项目指令：\`AGENTS.md\`、\`BilliardBuddy.md\`、\`.BilliardBuddy/BilliardBuddy.md\`
- 条件规则：\`.BilliardBuddy/rules/*.md\`
- 项目 Skills：\`.BilliardBuddy/skills/<skill-name>/SKILL.md\`

修改前先读取现有文件，只更改用户要求的字段，保留无关配置。Hooks 是 Harness 自动化，不是记忆：用户说“每次、以后总是、在工具前后、停止时”时，写入相应 Hook。Hook 命令会在本机执行，必须使用最小权限、明确工作目录、合理超时和不含密钥的中性示例。完成后重新读取配置并说明改了什么。`

const PRODUCT_SKILLIFY_PROMPT = `# 创建 BilliardBuddy Skill

把用户希望复用的工作方式整理成项目 Skill。

1. 先确认 Skill 的触发意图、输入、真实工具依赖、完成证据和失败边界。
2. 在 \`.BilliardBuddy/skills/<skill-name>/SKILL.md\` 创建目录格式 Skill；名称使用小写字母、数字和连字符。
3. 使用 YAML frontmatter 写 \`description\`，正文写清步骤、约束、验证与必要参考资料。不要把一次性任务记录、秘密、绝对用户路径或模型供应商写进 Skill。
4. 能用 BilliardBuddy 现有 Tool、MCP 和 Harness 合同完成时不要另造脚本；确有稳定脚本或模板时放在同一 Skill 目录并使用相对路径。
5. 创建后重新读取文件，检查触发描述不会过宽，并且只依赖当前 BilliardBuddy Harness 真实提供的能力。`

const PRODUCT_REMEMBER_PROMPT = `# 整理 BilliardBuddy 项目记忆

检查当前 Harness 已提供的项目记忆，以及项目中的 \`AGENTS.md\`、\`BilliardBuddy.md\`、\`.BilliardBuddy/BilliardBuddy.md\` 和 \`.BilliardBuddy/BilliardBuddy.local.md\`。

- 稳定、全项目适用的协作规则放在 \`AGENTS.md\` 或 \`BilliardBuddy.md\`。
- 仅本机适用且不应提交的规则放在 \`.BilliardBuddy/BilliardBuddy.local.md\`。
- 路径条件规则放在 \`.BilliardBuddy/rules/*.md\`，用 frontmatter \`paths\` 限定。
- 不要记录密钥、令牌、个人敏感信息、一次性状态、可以从代码直接推导的事实或未经验证的猜测。
- 先报告重复、冲突、过期和建议归属；只有用户要求写入时才修改文件，并保留无关内容。`

const PRODUCT_SIMPLIFY_PROMPT = `# 审查并简化当前代码改动

读取当前工作树差异，从复用、质量、边界和效率四方面检查，然后直接修复有证据的问题。

1. 查找已有工具、类型和状态源，消除重复实现与第二权威来源。
2. 检查权限、持久化、恢复、错误和并发边界，不能为了少代码删掉必要能力。
3. 检查不必要计算、重复 I/O、无界集合、监听器泄漏和串行等待。
4. 保留用户已有的无关工作，不做任务外清理，不改正确实现来迎合过时测试。
5. 运行相关测试和差异检查，分别报告已修复问题、等价实现、未验证项和真实缺口。`

function registerPromptSkill(name: string, description: string, prompt: string): void {
  registerProductBundledSkill({
    name,
    description,
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{
        type: 'text',
        text: args.trim() ? `${prompt}\n\n## 用户这次的要求\n\n${args.trim()}` : prompt,
      }]
    },
  })
}

export function registerProductHarnessSkills(): void {
  registerPromptSkill('update-config', '更新 BilliardBuddy 项目配置、Hooks 和指令。', PRODUCT_CONFIG_PROMPT)
  registerPromptSkill('skillify', '把可复用工作方式整理成 BilliardBuddy 项目 Skill。', PRODUCT_SKILLIFY_PROMPT)
  registerPromptSkill('remember', '整理 BilliardBuddy 项目指令和长期记忆。', PRODUCT_REMEMBER_PROMPT)
  registerPromptSkill('simplify', '审查并简化当前代码改动，同时保留完整工程能力。', PRODUCT_SIMPLIFY_PROMPT)
}
