import { runAgentLoop } from '../../src/harness/loop'
import { DEFAULT_MODEL_ENV_FILES, loadEnvFiles } from '../../src/model/envLoader'
import { createModelFromProviderConfig } from '../../src/model/modelFactory'
import { providerConfigFromEnv, redactedProviderSummary } from '../../src/model/providerConfig'
import { ToolRegistry } from '../../src/tools/registry'
import type { Tool } from '../../src/tools/Tool'
import { Workspace } from '../../src/workspace/workspace'

const args = process.argv.slice(2)
const envFiles = args.filter(arg => !arg.startsWith('--'))
const allowNoTool = args.includes('--allow-no-tool')
const mergedEnv = {
  ...process.env,
  ...loadEnvFiles(envFiles.length ? envFiles : DEFAULT_MODEL_ENV_FILES),
}

const config = providerConfigFromEnv(mergedEnv)
if (!config) {
  console.error('未找到可用模型配置:需要 ANTHROPIC_* 或 DEEPSEEK/OPENAI/TEXT_MODEL_* 环境变量')
  process.exit(1)
}

console.log('provider', JSON.stringify(redactedProviderSummary(config)))

const model = createModelFromProviderConfig(config)
const echoTool: Tool<{ text?: string }> = {
  name: 'echo_text',
  description: 'Return the provided text exactly. Use this for smoke testing tool calls.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  isReadOnly: true,
  async execute(input) {
    return String(input.text ?? '')
  },
}

let usedTool = false
let finalText = ''
for await (const ev of runAgentLoop({
  model,
  registry: new ToolRegistry([echoTool]),
  workspace: new Workspace(process.cwd()),
  systemPrompt: 'You are a smoke-test agent. For this test you must call echo_text exactly once before giving the final answer.',
  userMessage: 'Call echo_text with {"text":"pong"} first, then answer with the tool result.',
  maxTurns: 4,
  permissionMode: 'full',
  contextWindowChars: 200_000,
})) {
  if (ev.type === 'tool_call' && ev.tool === 'echo_text') usedTool = true
  if (ev.type === 'final') finalText = ev.text
}

if (!usedTool && !allowNoTool) {
  console.error('模型连通成功,但没有按要求触发工具调用')
  process.exit(2)
}

console.log(JSON.stringify({ ok: true, usedTool, finalPreview: finalText.slice(0, 120) }))
