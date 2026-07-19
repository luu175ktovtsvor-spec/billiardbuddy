import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkillDescriptors,
  getBundledSkills,
} from '../bundledSkills.js'
import {
  configureMediaWorkbenchDiscovery,
  MEDIA_WORKBENCH_SKILL_METADATA,
  registerMediaWorkbenchesSkill,
} from './mediaWorkbenches.js'

const originalDesktopServerUrl = process.env.BB_DESKTOP_SERVER_URL

describe('media workbench desktop discovery', () => {
  beforeEach(() => {
    clearBundledSkills()
    configureMediaWorkbenchDiscovery(false)
    delete process.env.BB_DESKTOP_SERVER_URL
  })

  afterEach(() => {
    clearBundledSkills()
    configureMediaWorkbenchDiscovery(false)
    if (originalDesktopServerUrl === undefined) delete process.env.BB_DESKTOP_SERVER_URL
    else process.env.BB_DESKTOP_SERVER_URL = originalDesktopServerUrl
  })

  test('keeps media commands out of product discovery without the Electron media capability', () => {
    registerMediaWorkbenchesSkill()

    const descriptors = getBundledSkillDescriptors()
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      'image-workbench',
      'video-workbench',
    ])
    expect(descriptors.every((descriptor) => descriptor.enabled === false)).toBe(true)
  })

  test('exposes both workbench Skills only after the server enables desktop discovery', () => {
    configureMediaWorkbenchDiscovery(true)
    registerMediaWorkbenchesSkill()

    const descriptors = getBundledSkillDescriptors().filter((descriptor) => descriptor.enabled)
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      ...MEDIA_WORKBENCH_SKILL_METADATA.map((metadata) => metadata.name),
    ])
    expect(descriptors.map((descriptor) => descriptor.displayName)).toEqual([
      ...MEDIA_WORKBENCH_SKILL_METADATA.map((metadata) => metadata.displayName),
    ])
  })

  test('keeps the child-process tool gate independent from product discovery', () => {
    configureMediaWorkbenchDiscovery(true)
    registerMediaWorkbenchesSkill()
    const commands = getBundledSkills()

    expect(commands.every((command) => command.isEnabled?.() === false)).toBe(true)

    process.env.BB_DESKTOP_SERVER_URL = 'http://127.0.0.1:4567'
    expect(commands.every((command) => command.isEnabled?.() === true)).toBe(true)
  })
})
