import { execFile } from 'node:child_process'
import { access, lstat, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyDirectory(args) {
  await execFileAsync('cp', args, { maxBuffer: 1024 * 1024 })
}

export async function materializeInstalledDependencies(repositoryPath, worktreePath) {
  const source = path.join(repositoryPath, 'node_modules')
  const target = path.join(worktreePath, 'node_modules')
  if (!(await pathExists(source))) return false

  const existing = await lstat(target).catch(() => null)
  if (existing) {
    if (!existing.isSymbolicLink()) return false
    await unlink(target)
  }

  // Next.js 16 uses Turbopack by default and deliberately rejects a project-level
  // node_modules symlink whose target is outside the worktree. A hard-link clone
  // keeps dependencies local from Turbopack's perspective without multiplying the
  // disk usage for every concurrent Codex task.
  try {
    await copyDirectory(['-al', '--', source, target])
    return true
  } catch (hardLinkError) {
    // Cross-device mounts cannot create hard links. Keep a portable, isolated
    // fallback so a different host layout does not make every task fail its gate.
    await rm(target, { recursive: true, force: true })
    try {
      await copyDirectory(['-a', '--reflink=auto', '--', source, target])
      return true
    } catch (copyError) {
      await rm(target, { recursive: true, force: true })
      const reason = copyError?.stderr || hardLinkError?.stderr || copyError?.message || hardLinkError?.message
      throw new Error(`Не вдалося підготувати node_modules для ${worktreePath}: ${reason}`)
    }
  }
}
