import type { EditorialApplication } from '../domain/editorial/editorialApplication.js'
import type { EditorialCommandPort } from '../runtime/videoWorkbenchApplicationPorts.js'

/**
 * Owns the CommandSet-only editorial version chain. Legacy endpoints reach
 * the same application so they cannot create an alternate Timeline writer.
 */
export class Editorial {
  constructor(
    private readonly commands: EditorialCommandPort,
    readonly rules: EditorialApplication,
  ) {}

  readonly getEditorialTimeline = (...args: Parameters<EditorialCommandPort['getEditorialTimeline']>) => this.commands.getEditorialTimeline(...args)
  readonly getTimelineDraft = (...args: Parameters<EditorialCommandPort['getTimelineDraft']>) => this.commands.getTimelineDraft(...args)
  readonly applyEditorialTimelineCommands = (...args: Parameters<EditorialCommandPort['applyEditorialTimelineCommands']>) => this.commands.applyEditorialTimelineCommands(...args)
  readonly acceptTimelineDraft = (...args: Parameters<EditorialCommandPort['acceptTimelineDraft']>) => this.commands.acceptTimelineDraft(...args)
  readonly updateTimeline = (...args: Parameters<EditorialCommandPort['updateTimeline']>) => this.commands.updateTimeline(...args)
  readonly selectTimelineVersion = (...args: Parameters<EditorialCommandPort['selectTimelineVersion']>) => this.commands.selectTimelineVersion(...args)
  readonly lockScene = (...args: Parameters<EditorialCommandPort['lockScene']>) => this.commands.lockScene(...args)
  readonly applyAlternative = (...args: Parameters<EditorialCommandPort['applyAlternative']>) => this.commands.applyAlternative(...args)
}
