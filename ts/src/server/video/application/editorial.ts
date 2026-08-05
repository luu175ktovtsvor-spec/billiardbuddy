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
  readonly updateDeliveryIntent = (...args: Parameters<EditorialCommandPort['updateDeliveryIntent']>) => this.commands.updateDeliveryIntent(...args)
  readonly getDurationFeasibility = (...args: Parameters<EditorialCommandPort['getDurationFeasibility']>) => this.commands.getDurationFeasibility(...args)
  readonly createSourceRangeDecision = (...args: Parameters<EditorialCommandPort['createSourceRangeDecision']>) => this.commands.createSourceRangeDecision(...args)
  readonly createEditorialPlans = (...args: Parameters<EditorialCommandPort['createEditorialPlans']>) => this.commands.createEditorialPlans(...args)
  readonly quickCreate = (...args: Parameters<EditorialCommandPort['quickCreate']>) => this.commands.quickCreate(...args)
  readonly createCreativeSession = (...args: Parameters<EditorialCommandPort['createCreativeSession']>) => this.commands.createCreativeSession(...args)
  readonly postCreativeMessage = (...args: Parameters<EditorialCommandPort['postCreativeMessage']>) => this.commands.postCreativeMessage(...args)
  readonly getCreativeProposal = (...args: Parameters<EditorialCommandPort['getCreativeProposal']>) => this.commands.getCreativeProposal(...args)
  readonly acceptCreativeProposal = (...args: Parameters<EditorialCommandPort['acceptCreativeProposal']>) => this.commands.acceptCreativeProposal(...args)
  readonly rejectCreativeProposal = (...args: Parameters<EditorialCommandPort['rejectCreativeProposal']>) => this.commands.rejectCreativeProposal(...args)
}
