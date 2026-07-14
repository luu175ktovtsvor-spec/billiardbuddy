/**
 * 主 agent 的持久记忆系统提示。行为语义对齐 cc-haha memdir/memdir.ts:buildMemoryLines:
 * 四类分类、排除项、写入、访问、召回核实、与计划/任务的边界、过往上下文搜索。
 *
 * 项目差异:
 *  A. memdir 使用本产品的白标路径,模型面不出现底层产品或厂商名。
 *  B. 写侧使用 save_memory,一步写入 frontmatter 主题文件并维护 MEMORY.md 索引。
 *  C. 模型侧机制使用英文;用户面输出语言由主系统提示的 Language 段决定。
 */

import { getAutoMemDir, AUTOMEM_ENTRYPOINT_NAME } from '../harness/memoryNames'
import { SAVE_MEMORY_TOOL_NAME } from '../tools/saveMemoryTool'

/** 装配主 agent 的记忆系统提示;workspaceRoot 用于注入白标 memdir 绝对路径。 */
export function buildMemorySystemPrompt(workspaceRoot: string): string {
  const memoryDir = getAutoMemDir(workspaceRoot)
  return [
    '# Persistent memory (across sessions)',
    '',
    `You have a file-based persistent memory system at \`${memoryDir}\`. Its index (${AUTOMEM_ENTRYPOINT_NAME}) is loaded into your context at the start of each session.`,
    'Build this memory over time so future sessions understand who the user is, how they prefer to collaborate, which approaches to repeat or avoid, and the non-obvious context behind their work.',
    'If the user explicitly asks you to remember something, save it immediately using the most appropriate type. If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Types of memory',
    'Every memory must use one of these four types:',
    '',
    '<types>',
    '<type>',
    '  <name>user</name>',
    "  <description>Information about the user's role, goals, responsibilities, knowledge, and stable preferences. Use it to make future collaboration more useful to this specific person. Do not store unrelated details or negative judgments.</description>",
    "  <when_to_save>When you learn durable details about the user's role, preferences, responsibilities, goals, or knowledge.</when_to_save>",
    "  <how_to_use>Adapt explanations, decisions, and collaboration style to the user's profile and existing mental model.</how_to_use>",
    '</type>',
    '<type>',
    '  <name>feedback</name>',
    '  <description>Guidance the user has given about how you should work, including both corrections and successful approaches to repeat. Record failure and success so the user does not need to give the same guidance twice.</description>',
    '  <when_to_save>When the user corrects your approach or confirms that a non-obvious approach worked. Save what applies to future conversations, especially when it is surprising or not derivable from the code, and include why.</when_to_save>',
    '  <how_to_use>Let these memories guide future behavior and preserve consistency with the user.</how_to_use>',
    '  <body_structure>Lead with the rule, then add a **Why:** line with the reason and a **How to apply:** line describing when the guidance applies.</body_structure>',
    '</type>',
    '<type>',
    '  <name>project</name>',
    '  <description>Non-obvious information about ongoing work, goals, initiatives, bugs, incidents, or decisions that cannot be derived from the current project state or git history. It provides the broader context and motivation behind work in this directory.</description>',
    '  <when_to_save>When you learn who is doing what, why, or by when. These states change quickly, so keep them current. Convert relative dates in user messages to absolute dates when saving.</when_to_save>',
    "  <how_to_use>Use these memories to understand the nuance behind the user's request and make better-informed suggestions.</how_to_use>",
    '  <body_structure>Lead with the fact or decision, then add a **Why:** line with its motivation and a **How to apply:** line explaining how it should shape future work.</body_structure>',
    '</type>',
    '<type>',
    '  <name>reference</name>',
    '  <description>Pointers to where current information can be found in external systems outside the project directory.</description>',
    '  <when_to_save>When you learn about a resource in an external system and what it is used for.</when_to_save>',
    '  <how_to_use>Use it when the user references that external system or when the needed information may live there.</how_to_use>',
    '</type>',
    '</types>',
    '',
    '## What not to save in memory',
    '',
    '- Code patterns, conventions, architecture, file paths, or project structure. Read the current project state instead.',
    '- Git history, recent changes, or who changed what. `git log` and `git blame` are authoritative.',
    '- Debugging solutions or fix recipes. The fix belongs in code and its rationale belongs in commit history.',
    '- Anything already documented in project instruction files.',
    '- Ephemeral task details such as in-progress work, temporary state, or current conversation context.',
    '- Secrets, credentials, API keys, or other sensitive values.',
    '',
    'These exclusions apply even when the user explicitly asks to save something. If they ask to save an activity list or temporary status summary, identify the surprising or non-obvious durable fact instead.',
    '',
    '## How to save memories',
    '',
    `Use the \`${SAVE_MEMORY_TOOL_NAME}\` tool. It writes the memory to a topic file with frontmatter (name, description, and type) and adds a pointer to ${AUTOMEM_ENTRYPOINT_NAME}; do not manually write the file or maintain the index.`,
    '',
    '- Make the description specific because future sessions use it to decide whether the memory is relevant.',
    '- Organize memories semantically by topic, not chronologically.',
    '- Before saving, check for an existing memory to update. Do not create duplicates; update or remove incorrect and outdated entries.',
    '- For feedback and project memories, follow the body_structure above: conclusion, **Why:**, then **How to apply:**.',
    '',
    '## When to access memory',
    '- Access memory when an entry appears relevant or the user refers to previous work.',
    '- If the user explicitly asks you to recall or check a past fact, you must access memory.',
    '- If the user says not to use or to ignore memory about a topic, treat the index as empty for that topic: do not apply, quote, compare, or mention that memory.',
    '- Memories become stale. Treat them as facts recorded at a point in time. Verify them against current files or resources before relying on them; if current evidence conflicts, trust the current evidence and update or delete the stale memory.',
    '',
    '## Before giving advice from memory',
    '',
    'A memory that names a file, function, or setting only asserts that it existed when the memory was written. It may have been renamed, removed, or never merged. Before relying on it:',
    '- If it names a file path, confirm that the file still exists.',
    '- If it names a function or setting, search for it.',
    '- If the user is about to act on your advice rather than asking only about history, verify it first.',
    'A memory saying that X exists does not prove that X exists now. When the user asks for current or recent status, prefer current files and `git log` over an old summary.',
    '',
    '## Memory and other persistence mechanisms',
    'Memory is for information that should remain useful in future sessions. Do not use it for information needed only in the current conversation.',
    '- Use a plan, not memory, to align on the approach for a non-trivial implementation. If the approach changes, update the plan.',
    '- Use tasks, not memory, to break down and track steps within the current conversation.',
    '',
    '## Before ending a turn',
    `Before your final response, briefly check whether the conversation introduced a durable user, feedback, project, or reference fact that will matter in future sessions. If it did and it has not been saved, use \`${SAVE_MEMORY_TOOL_NAME}\`. Do not force a memory when there is nothing durable to save.`,
    '',
    ...buildSearchingPastContextSection(memoryDir),
  ].join('\n')
}

/** 给模型可执行的过往上下文搜索方法。 */
export function buildSearchingPastContextSection(memoryDir: string): string[] {
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in the memory directory:',
    '```',
    `grep -rn "<keyword>" ${memoryDir} --include="*.md"`,
    '```',
    '2. Use narrow terms such as an error message, file path, or function name instead of broad keywords.',
  ]
}
