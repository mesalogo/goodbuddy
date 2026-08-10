import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeSkillPackage } from '../capabilities/capability-service'

export async function stageRuntimeSkillPackages(
  root: string,
  skillPackages: readonly RuntimeSkillPackage[],
  runtimeLabel: 'Continue' | 'OpenCode'
): Promise<string> {
  const skillsRoot = join(root, 'skills')
  try {
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
    for (const skill of skillPackages) {
      await cp(skill.directory, join(skillsRoot, skill.id), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true
      })
    }
    return skillsRoot
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw new Error(`${runtimeLabel} Skill 注册失败`, { cause: error })
  }
}
