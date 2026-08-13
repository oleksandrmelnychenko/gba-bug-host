import { execFile } from 'node:child_process'
import { access, lstat, rm, unlink, writeFile } from 'node:fs/promises'
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

export async function materializeInstalledDependencies(repositoryPath, worktreePath, { forceRefresh = false } = {}) {
  const source = path.join(repositoryPath, 'node_modules')
  const target = path.join(worktreePath, 'node_modules')
  const isolationMarker = path.join(target, '.gba-isolated-dependencies-v2')
  if (!(await pathExists(source))) return false

  const existing = await lstat(target).catch(() => null)
  if (existing) {
    if (!forceRefresh && !existing.isSymbolicLink() && await pathExists(isolationMarker)) return false
    if (existing.isSymbolicLink()) await unlink(target)
    else await rm(target, { recursive: true, force: true })
  }

  // Next.js 16 uses Turbopack by default and deliberately rejects a project-level
  // node_modules symlink whose target is outside the worktree. Reflinks keep the
  // tree local without sharing mutable inodes with mainline or another agent.
  // A hard-link clone is unsafe here: a package cache/build tool may rewrite a
  // linked file and silently mutate every active worktree.
  try {
    await copyDirectory(['-a', '--reflink=always', '--', source, target])
    await writeFile(isolationMarker, 'isolated-v2\n', 'utf8')
    return true
  } catch (reflinkError) {
    // Filesystems without copy-on-write still get a private copy. Isolation is a
    // correctness requirement; disk deduplication is only an optimisation.
    await rm(target, { recursive: true, force: true })
    try {
      await copyDirectory(['-a', '--', source, target])
      await writeFile(isolationMarker, 'isolated-v2\n', 'utf8')
      return true
    } catch (copyError) {
      await rm(target, { recursive: true, force: true })
      const reason = copyError?.stderr || reflinkError?.stderr || copyError?.message || reflinkError?.message
      throw new Error(`Не вдалося підготувати node_modules для ${worktreePath}: ${reason}`)
    }
  }
}
