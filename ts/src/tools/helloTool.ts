/** W1 起步桩工具:证明工具形状 + 测试框架。真工具框架(Tool.ts)在 W2。 */
export const helloTool = {
  name: 'hello' as const,
  description: 'Greets the given name. Placeholder tool proving the harness shape.',
  async execute(input: { name: string }): Promise<string> {
    return `Hello, ${input.name}!`
  },
}
