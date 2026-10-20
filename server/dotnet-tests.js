import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const SCAN_ROOTS = ['src', 'tests', 'tools']
const SKIPPED_DIRECTORIES = new Set(['bin', 'obj', 'node_modules', 'TestResults', '.git'])
const GLOBAL_BUILD_FILE = /(?:^|\/)(?:Directory\.(?:Build|Packages)\.(?:props|targets)|global\.json|nuget\.config|[^/]+\.slnx?)$/i
const CODE_FILE = /\.(?:cs|csproj|props|targets|resx|sql|json|xml|config)$/i
const MAXIMUM_DEPTH = 4
const MAXIMUM_FILTER_TERMS = 20

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function findProjectFiles(root, relativeDirectory, depth, found) {
  if (depth > MAXIMUM_DEPTH) return
  let entries
  try {
    entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (entry.isDirectory()) await findProjectFiles(root, child, depth + 1, found)
    else if (entry.isFile() && entry.name.endsWith('.csproj')) found.push(child)
  }
}

export function isDotnetTestProject(projectPath) {
  return projectPath.startsWith('tests/') && /tests?\.csproj$/i.test(path.posix.basename(projectPath))
}

export async function readDotnetProjectGraph(root) {
  const files = []
  for (const scanRoot of SCAN_ROOTS) await findProjectFiles(root, scanRoot, 1, files)
  const projects = []
  for (const projectPath of files.sort()) {
    const directory = `${path.posix.dirname(projectPath)}/`
    let content = ''
    try {
      content = await readFile(path.join(root, projectPath), 'utf8')
    } catch {
      content = ''
    }
    const references = [...content.matchAll(/<ProjectReference\s+Include="([^"]+)"/gi)]
      .map((match) => `${path.posix.dirname(path.posix.normalize(path.posix.join(path.posix.dirname(projectPath), toPosix(match[1]).replace(/\\/g, '/'))))}/`)
    projects.push({ path: projectPath, dir: directory, references: [...new Set(references)].sort(), test: isDotnetTestProject(projectPath) })
  }
  return { projects }
}

function owningProject(graph, file) {
  return graph.projects
    .filter((project) => file.startsWith(project.dir))
    .sort((left, right) => right.dir.length - left.dir.length)[0] ?? null
}

function closure(graph, project) {
  const byDirectory = new Map(graph.projects.map((item) => [item.dir, item]))
  const seen = new Set([project.dir])
  const stack = [...project.references]
  while (stack.length > 0) {
    const next = stack.pop()
    if (seen.has(next)) continue
    seen.add(next)
    for (const reference of byDirectory.get(next)?.references ?? []) stack.push(reference)
  }
  return seen
}

export function affectedDotnetTestProjects(graph, changedFiles = null) {
  const testProjects = graph.projects.filter((project) => project.test)
  if (changedFiles === null) return { all: true, reason: 'повна батарея', projects: testProjects.map((project) => project.path) }
  if (changedFiles.some((file) => GLOBAL_BUILD_FILE.test(file))) {
    return { all: true, reason: 'змінено спільні build-файли', projects: testProjects.map((project) => project.path) }
  }
  const changedDirectories = new Set()
  for (const file of changedFiles) {
    const owner = owningProject(graph, file)
    if (owner) {
      changedDirectories.add(owner.dir)
      continue
    }
    if (CODE_FILE.test(file) && SCAN_ROOTS.some((scanRoot) => file.startsWith(`${scanRoot}/`))) {
      return { all: true, reason: `файл поза відомими проєктами: ${file}`, projects: testProjects.map((project) => project.path) }
    }
  }
  const projects = testProjects
    .filter((project) => [...closure(graph, project)].some((directory) => changedDirectories.has(directory)))
    .map((project) => project.path)
  return { all: false, reason: 'тестові проєкти, що залежать від змінених проєктів', projects }
}

export function dotnetFastFilter(graph, testProjectPath, changedFiles = []) {
  const testProject = graph.projects.find((project) => project.path === testProjectPath)
  if (!testProject) return null
  const reachable = closure(graph, testProject)
  const terms = new Set()
  for (const file of changedFiles) {
    if (!file.endsWith('.cs')) continue
    const owner = owningProject(graph, file)
    if (!owner || !reachable.has(owner.dir)) continue
    const className = path.posix.basename(file, '.cs').replace(/[^A-Za-z0-9_]/g, '')
    if (!className) continue
    terms.add(owner.dir === testProject.dir ? className : `${className}Tests`)
    if (terms.size >= MAXIMUM_FILTER_TERMS) break
  }
  if (terms.size === 0) return null
  return [...terms].sort().map((term) => `FullyQualifiedName~${term}`).join('|')
}

export function dotnetTestCommand(projectPath, extraArgs = ['-v', 'q', '--nologo']) {
  return ['dotnet', 'test', projectPath, ...extraArgs]
}
