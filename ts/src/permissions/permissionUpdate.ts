import type { ToolContext } from '../tools/Tool'
import type { AdditionalWorkingDirectory, PermissionRule, PermissionUpdate } from './types'

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.source === b.source &&
    a.ruleBehavior === b.ruleBehavior &&
    a.ruleValue.toolName === b.ruleValue.toolName &&
    a.ruleValue.ruleContent === b.ruleValue.ruleContent
}

function ruleKey(rule: PermissionRule): string {
  return JSON.stringify([rule.source, rule.ruleBehavior, rule.ruleValue.toolName, rule.ruleValue.ruleContent ?? null])
}

function rulesFromUpdate(update: Extract<PermissionUpdate, { type: 'addRules' | 'replaceRules' | 'removeRules' }>): PermissionRule[] {
  return update.rules.map(ruleValue => ({
    source: update.destination,
    ruleBehavior: update.behavior,
    ruleValue,
  }))
}

function dedupeRules(rules: PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>()
  const out: PermissionRule[] = []
  for (const rule of rules) {
    const key = ruleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rule)
  }
  return out
}

function cloneAdditionalWorkingDirectories(ctx: ToolContext): Map<string, AdditionalWorkingDirectory> {
  return new Map(ctx.additionalWorkingDirectories ?? [])
}

export function applyPermissionUpdate(ctx: ToolContext, update: PermissionUpdate): ToolContext {
  switch (update.type) {
    case 'setMode':
      return { ...ctx, permissionMode: update.mode }
    case 'addRules':
      return {
        ...ctx,
        permissionRules: dedupeRules([...(ctx.permissionRules ?? []), ...rulesFromUpdate(update)]),
      }
    case 'replaceRules': {
      const existing = (ctx.permissionRules ?? []).filter(rule =>
        !(rule.source === update.destination && rule.ruleBehavior === update.behavior),
      )
      return { ...ctx, permissionRules: dedupeRules([...existing, ...rulesFromUpdate(update)]) }
    }
    case 'removeRules': {
      const toRemove = rulesFromUpdate(update)
      return {
        ...ctx,
        permissionRules: (ctx.permissionRules ?? []).filter(rule => !toRemove.some(candidate => sameRule(rule, candidate))),
      }
    }
    case 'addDirectories': {
      const dirs = cloneAdditionalWorkingDirectories(ctx)
      for (const directory of update.directories) {
        dirs.set(directory, { path: directory, source: update.destination })
      }
      return { ...ctx, additionalWorkingDirectories: dirs }
    }
    case 'removeDirectories': {
      const dirs = cloneAdditionalWorkingDirectories(ctx)
      for (const directory of update.directories) dirs.delete(directory)
      return { ...ctx, additionalWorkingDirectories: dirs }
    }
  }
}

export function applyPermissionUpdates(ctx: ToolContext, updates: PermissionUpdate[]): ToolContext {
  return updates.reduce((current, update) => applyPermissionUpdate(current, update), ctx)
}
