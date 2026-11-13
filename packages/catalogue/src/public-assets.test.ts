import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { skillMd } from './generate.js'

const root = new URL('../../../', import.meta.url)

describe('public integration assets', () => {
  it('keeps the installable skill in sync with the catalogue', () => {
    expect(readFileSync(new URL('skills/helm7/SKILL.md', root), 'utf8')).toBe(skillMd('https://www.helm7.com'))
  })

  it('points the Cursor plugin at the hosted server without embedding a credential', () => {
    const config = JSON.parse(readFileSync(new URL('mcp.json', root), 'utf8'))
    expect(config.mcpServers.helm7).toEqual({ url: 'https://www.helm7.com/mcp' })
  })
})
