import { registerBilliardsOperationsSkills } from './billiardsOperations.js'
import { registerBossRecruitingSkill } from './bossRecruiting.js'
import { registerProductHarnessSkills } from './productHarness.js'

/** Register only built-ins whose prompts belong to the BilliardBuddy product. */
export function initProductBundledSkills(): void {
  registerProductHarnessSkills()
  registerBilliardsOperationsSkills()
  registerBossRecruitingSkill()
}
