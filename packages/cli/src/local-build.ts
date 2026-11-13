/**
 * Building on the person's own machine, so a deploy does not wait in Helm7's
 * build queue.
 *
 * Docker does the building and saving; this only decides whether it can, then
 * moves the archive up in chunks the server accepts in order. Everything goes
 * to stderr, which keeps `--json` output on stdout parseable.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Helm7 } from '@helm7/sdk'

const run = promisify(execFile)

export interface LocalBuildOptions {
  /** Directory the command runs in; where the Dockerfile is looked for. */
  cwd: string
  dockerfile?: string | undefined
  context?: string | undefined
}

export type LocalBuildSupport = { ok: true; dockerfile: string; context: string } | { ok: false; reason: string }

/** Whether this machine can build the image: Docker is running, and there is a Dockerfile to build. */
export async function localBuildSupport(options: LocalBuildOptions, exec: typeof run = run): Promise<LocalBuildSupport> {
  const context = resolve(options.cwd, options.context ?? '.')
  const dockerfile = resolve(options.cwd, options.dockerfile ?? join(context, 'Dockerfile'))
  if (!existsSync(dockerfile)) {
    return { ok: false, reason: `There is no Dockerfile at ${dockerfile}. A local build uses yours; pass --dockerfile, or build on Helm7 with --build remote.` }
  }
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 })
  } catch {
    return { ok: false, reason: 'Docker is not running on this machine. Start it, or build on Helm7 with --build remote.' }
  }
  return { ok: true, dockerfile, context }
}

export interface LocalDeployment {
  id: string
  service?: string
  upload: { image: string; chunk_bytes: number; max_bytes: number }
}

export interface Steps {
  /** Runs a command with its output on stderr; rejects on a non-zero exit. */
  stream: (argv: string[], cwd: string) => Promise<void>
  /** `git rev-parse HEAD`, or undefined outside a repository. */
  commit: (cwd: string) => Promise<string | undefined>
}

const realSteps: Steps = {
  stream: (argv, cwd) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 2, 2] })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${argv.slice(0, 2).join(' ')} exited with ${code}`))))
    }),
  commit: async (cwd) => {
    try {
      return (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim() || undefined
    } catch {
      return undefined
    }
  },
}

/** Builds, saves, uploads and finishes one local deployment. */
export async function buildAndUpload(
  client: Helm7,
  productId: string,
  deployment: LocalDeployment,
  support: Extract<LocalBuildSupport, { ok: true }>,
  log: (line: string) => void,
  steps: Steps = realSteps,
): Promise<void> {
  const label = deployment.service ?? deployment.id
  const dir = await mkdtemp(join(tmpdir(), 'helm7-local-'))
  const archive = join(dir, 'image.tar')
  try {
    log(`Building ${label} on this machine`)
    // The tag is the server's, exactly: it looks for that name after loading.
    await steps.stream(['docker', 'build', '-f', support.dockerfile, '-t', deployment.upload.image, support.context], support.context)
    log('Saving the image')
    await steps.stream(['docker', 'save', '-o', archive, deployment.upload.image], support.context)

    const size = (await stat(archive)).size
    if (size > deployment.upload.max_bytes) {
      throw new Error(`The image is ${Math.round(size / 1024 / 1024)} MB; a local build may upload at most ${Math.round(deployment.upload.max_bytes / 1024 / 1024)} MB. Build on Helm7 with --build remote, or slim the image.`)
    }

    const sha256 = await sendChunks(client, productId, deployment, archive, size, log)
    await client.deployments.finishImage(productId, deployment.id, { size, sha256, ...(await optional('commit', steps.commit(support.context))) })
    log(`Uploaded ${label}. It goes live once the new run is healthy.`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function optional(key: string, value: Promise<string | undefined>): Promise<Record<string, string>> {
  const resolved = await value
  return resolved ? { [key]: resolved } : {}
}

async function sendChunks(client: Helm7, productId: string, deployment: LocalDeployment, archive: string, size: number, log: (line: string) => void): Promise<string> {
  const hash = createHash('sha256')
  const file = await open(archive, 'r')
  try {
    let offset = 0
    let lastPercent = -1
    while (offset < size) {
      const buffer = Buffer.alloc(Math.min(deployment.upload.chunk_bytes, size - offset))
      await file.read(buffer, 0, buffer.length, offset)
      hash.update(buffer)
      await withRetry(() => client.deployments.uploadImageChunk(productId, deployment.id, offset, buffer))
      offset += buffer.length
      const percent = Math.floor((offset / size) * 100)
      if (percent >= lastPercent + 10) {
        log(`Uploading ${percent}%`)
        lastPercent = percent
      }
    }
  } finally {
    await file.close()
  }
  return hash.digest('hex')
}

/** A dropped connection mid-upload is not a failed deploy: the server takes the same chunk twice. */
async function withRetry<T>(attempt: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt()
    } catch (error) {
      if (i >= tries || (error as { status?: number }).status === 409) throw error
      await new Promise((r) => setTimeout(r, 500 * i))
    }
  }
}
