import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultScriptPath = path.join(moduleDirectory, 'transcribe-local.py')
const extensionByType = new Map([
  ['audio/webm', '.webm'],
  ['video/webm', '.webm'],
  ['audio/mp4', '.m4a'],
  ['video/mp4', '.mp4'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mpga', '.mpga'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
])

export class TranscriptionError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'TranscriptionError'
    this.status = status
  }
}

function tail(value, maximum = 20_000) {
  return value.length > maximum ? value.slice(-maximum) : value
}

function runCommand(command, args, { timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      stdout = tail(stdout + chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString())
    })
    child.on('error', reject)

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, timeoutMs)
    timeout.unref()

    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code: code ?? 1, signal, stdout, stderr, timedOut })
    })
  })
}

function parseTranscript(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(lines[index])
      if (typeof payload.text === 'string') return payload.text.trim()
    } catch {
      // Модель може писати службовий прогрес перед фінальним JSON.
    }
  }
  return ''
}

export async function transcribeAudioWithShell(file, options = {}) {
  const pythonBinary = options.pythonBinary ?? process.env.VOICE_TRANSCRIBE_PYTHON ?? 'python3'
  const scriptPath = options.scriptPath ?? defaultScriptPath
  const timeoutMs = options.timeoutMs
    ?? Number.parseInt(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS ?? String(3 * 60 * 1000), 10)
  const runProcess = options.runProcess ?? runCommand
  const extension = extensionByType.get(file.mimetype) ?? '.webm'
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gba-voice-'))
  const audioPath = path.join(temporaryDirectory, `recording${extension}`)

  try {
    await writeFile(audioPath, file.buffer, { mode: 0o600 })

    let result
    try {
      result = await runProcess(pythonBinary, [scriptPath, audioPath], {
        timeoutMs,
        env: process.env,
      })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new TranscriptionError('Локальний voice worker не встановлено на сервері.', 503)
      }
      throw new TranscriptionError('Не вдалося запустити локальне розпізнавання голосу.')
    }

    if (result.timedOut) {
      throw new TranscriptionError('Розпізнавання голосу тривало надто довго. Спробуйте коротший запис.', 504)
    }
    if (result.code !== 0) {
      console.error('Local transcription failed:', tail(result.stderr || result.stdout))
      const isMissingDependency = /No module named ['"]faster_whisper|ModuleNotFoundError/i.test(result.stderr)
      throw new TranscriptionError(
        isMissingDependency
          ? 'Локальний voice worker не встановлено на сервері.'
          : 'Не вдалося розпізнати запис. Спробуйте ще раз.',
        isMissingDependency ? 503 : 502,
      )
    }

    const text = parseTranscript(result.stdout)
    if (!text) {
      throw new TranscriptionError('У записі не вдалося розпізнати текст.', 422)
    }
    return text
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
