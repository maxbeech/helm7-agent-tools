import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAndUpload, localBuildSupport, type Steps } from './local-build.js'

const deployment = { id: 'dep_1', service: 'web', upload: { image: 'helm7/shop-web:dep_1', chunk_bytes: 4, max_bytes: 100 } }
const support = { ok: true as const, dockerfile: '/p/Dockerfile', context: '/p' }

function fakes(archive: Buffer, flaky = false) {
  const uploaded: Array<{ offset: number; data: Buffer }> = []
  let failures = flaky ? 1 : 0
  const finished: unknown[] = []
  const client = {
    deployments: {
      uploadImageChunk: async (_p: string, _d: string, offset: number, data: Uint8Array) => {
        if (failures-- > 0) throw Object.assign(new Error('connection reset'), { status: 502 })
        uploaded.push({ offset, data: Buffer.from(data) })
        return { received: offset + data.length }
      },
      finishImage: async (_p: string, _d: string, input: unknown) => void finished.push(input),
    },
  }
  const commands: string[][] = []
  const steps: Steps = {
    stream: async (argv) => {
      commands.push(argv)
      // `docker save -o <path> <image>` is what writes the archive.
      if (argv[1] === 'save') await writeFile(argv[3]!, archive)
    },
    commit: async () => 'abc1234',
  }
  return { client: client as never, steps, uploaded, finished, commands }
}

describe('building on this machine', () => {
  it('builds with the server\'s tag, uploads in order, and finishes with the checksum and commit', async () => {
    const archive = Buffer.from('0123456789')
    const f = fakes(archive)
    const lines: string[] = []
    await buildAndUpload(f.client, 'prd_1', deployment, support, (l) => lines.push(l), f.steps)

    expect(f.commands[0]).toEqual(['docker', 'build', '-f', '/p/Dockerfile', '-t', 'helm7/shop-web:dep_1', '/p'])
    expect(f.uploaded.map((u) => u.offset)).toEqual([0, 4, 8])
    expect(Buffer.concat(f.uploaded.map((u) => u.data))).toEqual(archive)
    expect(f.finished).toEqual([{ size: 10, sha256: createHash('sha256').update(archive).digest('hex'), commit: 'abc1234' }])
  })

  it('retries a chunk after a dropped connection', async () => {
    const f = fakes(Buffer.from('abcd'), true)
    await buildAndUpload(f.client, 'prd_1', deployment, support, () => undefined, f.steps)
    expect(f.uploaded).toHaveLength(1)
    expect(f.finished).toHaveLength(1)
  })

  it('refuses an image over the limit before sending any of it', async () => {
    const f = fakes(Buffer.alloc(101))
    await expect(buildAndUpload(f.client, 'prd_1', deployment, support, () => undefined, f.steps)).rejects.toThrow(/at most 0 MB|--build remote/)
    expect(f.uploaded).toHaveLength(0)
    expect(f.finished).toHaveLength(0)
  })
})

describe('whether this machine can build', () => {
  it('says what is missing when there is no Dockerfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h7-cli-'))
    const r = await localBuildSupport({ cwd: dir }, (async () => ({ stdout: '', stderr: '' })) as never)
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('no Dockerfile') })
  })

  it('says so when Docker is not running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h7-cli-'))
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch')
    const r = await localBuildSupport({ cwd: dir }, (async () => { throw new Error('no daemon') }) as never)
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('Docker is not running') })
  })

  it('is ready with a Dockerfile and a running Docker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h7-cli-'))
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch')
    const r = await localBuildSupport({ cwd: dir }, (async () => ({ stdout: '27.0', stderr: '' })) as never)
    expect(r).toEqual({ ok: true, dockerfile: join(dir, 'Dockerfile'), context: dir })
  })
})
