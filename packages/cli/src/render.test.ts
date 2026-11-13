import { describe, it, expect } from 'vitest'
import type { Plan } from '@helm7/sdk'
import { isPlan, renderError, renderPlan, renderRecord, renderResult, renderRows, toRenderableError } from './render.js'

const ESC = String.fromCharCode(27)

const PLAN: Plan = {
  changes: [
    { action: 'create', resource: 'database', name: 'primary', detail: 'Postgres 17, pgvector enabled', destructive: false },
    { action: 'update', resource: 'service', name: 'web', detail: 'shared-0.25 to standard-1', destructive: false },
    { action: 'delete', resource: 'domain', name: 'old.example.com', detail: 'certificate revoked', destructive: true },
  ],
  cost: {
    currency: 'USD',
    monthly_low: 24,
    monthly_high: 31,
    delta_low: 6,
    delta_high: 9,
    main_driver: 'standard-1 service, always on',
  },
  destructive_actions: ['old.example.com stops serving traffic and its certificate is revoked'],
  applied: false,
}

describe('renderPlan', () => {
  it('renders a plan a person can read at a glance', () => {
    expect(renderPlan(PLAN, { dryRun: true })).toBe(
      [
        'Plan  3 changes, 1 destructive',
        '',
        '  + database  primary          Postgres 17, pgvector enabled',
        '  ~ service   web              shared-0.25 to standard-1',
        '  - domain    old.example.com  certificate revoked',
        '',
        'Cost  USD 24.00 to 31.00 per month  (+6.00 to +9.00)',
        '      largest driver: standard-1 service, always on',
        '      estimate, not a quote',
        '',
        'Irreversible',
        '  ! old.example.com stops serving traffic and its certificate is revoked',
        '',
        'Nothing was applied: this was a dry run.',
        'Re-run without --dry-run to apply it.',
      ].join('\n'),
    )
  })

  it('emits no escape codes when colour is off', () => {
    // The output goes into pipes, logs and pull requests. Escape codes in any
    // of those are noise nobody can strip after the fact.
    expect(renderPlan(PLAN, { colour: false })).not.toContain(ESC)
    expect(renderPlan(PLAN, {})).not.toContain(ESC)
  })

  it('emits escape codes when colour is on', () => {
    expect(renderPlan(PLAN, { colour: true })).toContain(ESC)
  })

  it('aligns the resource and name columns whatever their widths', () => {
    const lines = renderPlan(PLAN).split('\n').slice(2, 5)
    const nameStarts = lines.map((line) => line.indexOf(line.trim().split(/\s+/)[2]!))
    expect(new Set(nameStarts).size).toBe(1)
  })

  it('tells a refused destructive call from a dry run', () => {
    expect(renderPlan(PLAN, { dryRun: false })).toContain('needs confirmation')
    expect(renderPlan(PLAN, { dryRun: false })).toContain('--confirm')
    expect(renderPlan(PLAN, { dryRun: true })).toContain('dry run')
  })

  it('says so plainly when the change was applied', () => {
    expect(renderPlan({ ...PLAN, applied: true })).toContain('Applied.')
  })

  it('handles a plan that changes nothing', () => {
    const empty: Plan = { changes: [], cost: PLAN.cost, destructive_actions: [], applied: false }
    const output = renderPlan(empty, { dryRun: true })
    expect(output).toContain('Plan  no changes')
    expect(output).not.toContain('Irreversible')
  })

  it('marks a no-op row rather than dropping it', () => {
    const plan: Plan = {
      ...PLAN,
      changes: [{ action: 'no-op', resource: 'service', name: 'web', destructive: false }],
      destructive_actions: [],
    }
    expect(renderPlan(plan)).toContain('= service  web')
  })

  it('says when the bill does not move', () => {
    const plan: Plan = { ...PLAN, cost: { ...PLAN.cost, delta_low: 0, delta_high: 0 } }
    expect(renderPlan(plan)).toContain('(no change to the bill)')
  })

  it('collapses a range with one value', () => {
    const plan: Plan = { ...PLAN, cost: { ...PLAN.cost, monthly_low: 12, monthly_high: 12 } }
    expect(renderPlan(plan)).toContain('Cost  USD 12.00 per month')
  })
})

describe('isPlan', () => {
  it('recognises a plan and nothing else', () => {
    expect(isPlan(PLAN)).toBe(true)
    expect(isPlan({ data: [] })).toBe(false)
    expect(isPlan(null)).toBe(false)
    expect(isPlan('plan')).toBe(false)
  })
})

describe('renderError', () => {
  it('prints code, message and the remedy line', () => {
    const error = {
      code: 'budget_exceeded',
      message: 'this key has spent its monthly cap',
      remedy: 'raise budget_usd on the key, or wait for the period to roll',
      requestId: 'req_9',
    }
    expect(renderError(error)).toBe(
      [
        'budget_exceeded: this key has spent its monthly cap',
        '  remedy: raise budget_usd on the key, or wait for the period to roll',
        '  request id: req_9',
      ].join('\n'),
    )
  })

  it('prints the docs link before the request id', () => {
    const out = renderError({ code: 'conflict', message: 'name in use', docsUrl: 'https://www.helm7.com/docs/errors#conflict', requestId: 'req_1' })
    expect(out.split('\n')).toEqual([
      'conflict: name in use',
      '  docs: https://www.helm7.com/docs/errors#conflict',
      '  request id: req_1',
    ])
  })

  it('omits the remedy line when there is no remedy to give', () => {
    expect(renderError({ code: 'not_found', message: 'no such Product' })).toBe('not_found: no such Product')
  })

  it('survives something that is not a Helm7 error at all', () => {
    expect(toRenderableError(new Error('boom'))).toEqual({ code: 'cli_error', message: 'boom' })
    expect(toRenderableError('boom')).toEqual({ code: 'cli_error', message: 'boom' })
  })
})

describe('renderResult', () => {
  it('renders a list envelope row by row', () => {
    const output = renderResult({ data: [{ id: 'prd_1', name: 'shop' }] })
    expect(output).toContain('prd_1')
    expect(output).toContain('shop')
  })

  it('says nothing to show rather than printing an empty frame', () => {
    expect(renderResult({ data: [] })).toBe('Nothing to show.')
  })

  it('aligns a record and keeps nested objects as JSON', () => {
    expect(renderRecord({ id: 'prd_1', graph: { services: 2 } })).toBe(
      ['id     prd_1', 'graph  {"services":2}'].join('\n'),
    )
  })

  it('renders a plan when it is handed one', () => {
    expect(renderResult(PLAN, { dryRun: true })).toContain('Plan  3 changes')
  })
})

describe('renderRows', () => {
  it('aligns columns in first-seen order and leaves nulls blank', () => {
    expect(renderRows([{ id: 1, name: 'ada' }, { id: 22, extra: true }])).toBe(
      ['id  name  extra', '--  ----  -----', '1   ada', '22        true'].join('\n'),
    )
  })

  it('cuts a long cell and flattens its newlines, so one column cannot push the rest off screen', () => {
    const [, , row] = renderRows([{ body: `a\nb${'x'.repeat(100)}` }]).split('\n')
    expect(row!.length).toBe(60)
    expect(row!.endsWith('…')).toBe(true)
    expect(row).not.toContain('\n')
  })

  it('says so when there are none', () => {
    expect(renderRows([])).toBe('(no rows)')
  })
})
