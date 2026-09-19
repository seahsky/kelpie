// Runs kelpie's workflow scripts against mocked workflow hooks, so script logic is tested without spawning agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const loadWorkflow = async (name) => {
  const source = await readFile(new URL(`../workflows/${name}.js`, import.meta.url), 'utf8')
  // Workflow scripts are module-shaped with a top-level return, so run the body as an async function.
  const body = source.replace(/^export const meta\b/m, 'const meta')
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', body)
}

// Mirrors the documented hook contracts: pipeline stages get (prevResult, originalItem, index), and a throwing stage or thunk yields null.
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk().catch(() => null)))
const pipeline = (items, ...stages) => Promise.all(items.map((item, index) =>
  stages
    .reduce((prev, stage) => prev.then((value) => stage(value, item, index)), Promise.resolve(item))
    .catch(() => null)))

const runWorkflow = async (name, { args, respond }) => {
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return respond({ prompt, opts, index: calls.length - 1 })
  }
  const workflow = await loadWorkflow(name)
  const result = await workflow(args, agent, parallel, pipeline, () => {}, (message) => logs.push(message))
  return { result, calls, logs }
}

test('fix-until-check-passes gives each tier two attempts, then stops', async () => {
  const { result, calls } = await runWorkflow('fix-until-check-passes', {
    args: { checkCommand: 'npm test' },
    respond: ({ index }) => ({ passing: false, summary: `summary-${index + 1}` }),
  })
  // The second tier is the session tier, which carries no agentType — escalation leaves the pinned role entirely.
  assert.deepEqual(calls.map((c) => c.opts.agentType), [
    'kelpie:mech-executor', 'kelpie:mech-executor', undefined, undefined,
  ])
  assert.deepEqual(calls.map((c) => c.opts.label), [
    'attempt-1-kelpie:mech-executor', 'attempt-2-kelpie:mech-executor', 'attempt-3-session-tier', 'attempt-4-session-tier',
  ])
  assert.equal(result.passing, false)
  assert.equal(result.attempts, 4)
  assert.equal(result.escalated, true)
})

test('fix-until-check-passes passes earlier summaries into each retry', async () => {
  const { result, calls } = await runWorkflow('fix-until-check-passes', {
    args: { checkCommand: 'npm test' },
    respond: ({ index }) => ({ passing: index === 2, summary: `summary-${index + 1}` }),
  })
  assert.equal(calls.length, 3)
  assert.ok(!calls[0].prompt.includes('summary-'))
  assert.ok(calls[1].prompt.includes('summary-1'))
  assert.ok(calls[2].prompt.includes('summary-1') && calls[2].prompt.includes('summary-2'))
  assert.equal(result.passing, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.escalated, true)
})

test('fix-until-check-passes honours a lower maxAttempts', async () => {
  const { result, calls } = await runWorkflow('fix-until-check-passes', {
    args: { checkCommand: 'npm test', maxAttempts: 1 },
    respond: () => ({ passing: false, summary: 'summary-1' }),
  })
  assert.equal(calls.length, 1)
  assert.equal(result.escalated, false)
})

test('fix-until-check-passes rejects maxAttempts outside two attempts per tier', async () => {
  for (const maxAttempts of [0, 5, 2.5]) {
    await assert.rejects(
      runWorkflow('fix-until-check-passes', {
        args: { checkCommand: 'npm test', maxAttempts },
        respond: () => ({ passing: true, summary: '' }),
      }),
      /maxAttempts/,
    )
  }
})

for (const name of ['migrate-in-parallel', 'audit-many-files']) {
  test(`${name} rejects duplicate paths`, async () => {
    await assert.rejects(
      runWorkflow(name, {
        args: { paths: ['src/a.ts', './src/a.ts', 'src/b.ts'], transformation: 't', concern: 'c' },
        respond: () => ({}),
      }),
      /duplicates: src\/a\.ts$/,
    )
  })

  test(`${name} spawns one first-stage agent per unique path`, async () => {
    const { calls } = await runWorkflow(name, {
      args: { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', concern: 'c' },
      respond: () => ({ changed: false, summary: 'no match', findings: [] }),
    })
    assert.equal(calls.length, 2)
  })
}

test('migrate-in-parallel settles correctness with one check run, not one verifier per file', async () => {
  const { result, calls } = await runWorkflow('migrate-in-parallel', {
    args: { paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'], transformation: 't', checkCommand: 'npm test' },
    respond: ({ opts }) => opts.label.startsWith('check:')
      ? { passing: true, output: '', failingPaths: [] }
      : { changed: true, summary: 'done' },
  })
  // Three migrations plus exactly one check — not three verifier spawns.
  assert.equal(calls.length, 4)
  assert.equal(calls.filter((c) => c.opts.agentType === 'kelpie:verifier').length, 0)
  const check = calls.at(-1)
  assert.equal(check.opts.label, 'check:npm test')
  assert.equal(check.opts.agentType, undefined)
  assert.equal(result.check.passing, true)
  assert.deepEqual(result.flagged, [])
})

test('migrate-in-parallel flags the paths a failing check names', async () => {
  const { result } = await runWorkflow('migrate-in-parallel', {
    args: { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test' },
    respond: ({ opts }) => opts.label.startsWith('check:')
      ? { passing: false, output: 'a.ts failed', failingPaths: ['src/b.ts'] }
      : { changed: true, summary: 'done' },
  })
  assert.equal(result.check.passing, false)
  assert.deepEqual(result.flagged.map((r) => r.path), ['src/b.ts'])
})

test('migrate-in-parallel falls back to per-file verifiers only when no check command is given', async () => {
  const { calls, logs } = await runWorkflow('migrate-in-parallel', {
    args: { paths: ['src/a.ts', 'src/b.ts'], transformation: 't' },
    respond: ({ opts }) => opts.agentType === 'kelpie:verifier'
      ? { correct: true, reasoning: 'fine' }
      : { changed: true, summary: 'done' },
  })
  assert.equal(calls.filter((c) => c.opts.agentType === 'kelpie:verifier').length, 2)
  assert.ok(logs.some((l) => l.includes('no args.checkCommand')))
})

// The spawn gate (hooks/jev-gate/) can redirect any spawn below, so these tests pin what the workflows do with no
// gate configured. That is the state every kelpie install is in until someone sets a Jev API key, and the pins below
// are the exact opts the shipped roles' frontmatter is meant to decide. If the gate ever changes them, these fail.

const optsWithoutGate = async (name, args, respond) => {
  const { calls } = await runWorkflow(name, { args, respond })
  return calls.map((c) => ({ label: c.opts.label, ...c.opts, schema: undefined }))
}

test('audit-many-files without a gate sets no model and no effort on any spawn', async () => {
  const opts = await optsWithoutGate(
    'audit-many-files',
    { paths: ['src/a.ts', 'src/b.ts'], concern: 'off-by-one errors' },
    ({ opts: o }) => o.label.startsWith('audit:')
      ? { findings: [{ line: 3, description: 'off by one' }] }
      : { confirmed: true, reasoning: 'checked' },
  )
  assert.deepEqual(opts.map((o) => [o.label, o.agentType, o.model, o.effort]), [
    // The finder runs at the session tier with nothing pinned, which is the measured choice, not an oversight.
    ['audit:src/a.ts', undefined, undefined, undefined],
    ['audit:src/b.ts', undefined, undefined, undefined],
    // The verifier's model and effort come from its own frontmatter (inherit, medium), so the script passes neither.
    ['verify:src/a.ts', 'kelpie:verifier', undefined, undefined],
    ['verify:src/b.ts', 'kelpie:verifier', undefined, undefined],
  ])
})

test('migrate-in-parallel without a gate sets no model and no effort on any spawn', async () => {
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test' },
    ({ opts: o }) => o.label.startsWith('check:')
      ? { passing: true, output: '', failingPaths: [] }
      : { changed: true, summary: 'done' },
  )
  assert.deepEqual(opts.map((o) => [o.label, o.agentType, o.model, o.effort]), [
    // mech-executor's sonnet/low pins live in its frontmatter, so the script passes neither model nor effort.
    ['migrate:src/a.ts', 'kelpie:mech-executor', undefined, undefined],
    ['migrate:src/b.ts', 'kelpie:mech-executor', undefined, undefined],
    ['check:npm test', undefined, undefined, undefined],
  ])
})

test('an empty gate object is treated as no gate at all', async () => {
  const withEmpty = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts'], transformation: 't', checkCommand: 'npm test', gate: { byPath: {}, verify: null } },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual(withEmpty.map((o) => [o.agentType, o.model, o.effort]), [
    ['kelpie:mech-executor', undefined, undefined],
    [undefined, undefined, undefined],
  ])
})

test('a gate decision reaches the role, the model, and the effort of each spawn', async () => {
  const gate = {
    byPath: {
      // agentType null means the session tier on purpose, so the role is dropped rather than left pinned.
      'src/a.ts': { agentType: null, model: null, effort: 'high' },
      'src/b.ts': { agentType: 'kelpie:mech-executor', model: 'haiku', effort: 'low' },
    },
    verify: null,
  }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test', gate },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual(opts.slice(0, 2).map((o) => [o.agentType, o.model, o.effort]), [
    [undefined, undefined, 'high'],
    ['kelpie:mech-executor', 'haiku', 'low'],
  ])
  // The executable check is never gated, so it keeps the session tier with nothing pinned.
  assert.deepEqual([opts[2].agentType, opts[2].model, opts[2].effort], [undefined, undefined, undefined])
})

test('a path the gate said nothing about keeps its shipped role', async () => {
  const gate = { byPath: { 'src/a.ts': { agentType: null, model: 'haiku', effort: 'low' } }, verify: null }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test', gate },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual([opts[1].agentType, opts[1].model], ['kelpie:mech-executor', undefined])
})

test("audit-many-files applies the gate's one verify decision to every verifier spawn", async () => {
  const gate = {
    byPath: { 'src/a.ts': { agentType: null, model: 'haiku', effort: 'low' } },
    verify: { agentType: 'kelpie:verifier', model: 'haiku', effort: 'low' },
  }
  const opts = await optsWithoutGate(
    'audit-many-files',
    { paths: ['src/a.ts'], concern: 'c', gate },
    ({ opts: o }) => o.label.startsWith('audit:')
      ? { findings: [{ line: 1, description: 'one' }, { line: 2, description: 'two' }] }
      : { confirmed: true, reasoning: 'checked' },
  )
  const verifiers = opts.filter((o) => o.label.startsWith('verify:'))
  assert.equal(verifiers.length, 2, 'the findings do not exist when the gate runs, so one decision covers them all')
  for (const v of verifiers) assert.deepEqual([v.agentType, v.model, v.effort], ['kelpie:verifier', 'haiku', 'low'])
})

// The one reviewed cell, as hooks/jev-gate/policy.mjs emits it: hard and long-horizon, so the executor is already
// the top rung at xhigh and the review is a second, independent read at the same tier.
const REVIEW_TIER = { agentType: 'kelpie:verifier', model: 'opus', effort: 'xhigh' }
const HARD_LONG = { agentType: null, model: 'opus', effort: 'xhigh', review: REVIEW_TIER }
// Hard but short: sonnet, and no review at all.
const HARD_SHORT = { agentType: null, model: 'sonnet', effort: 'high', review: null }

test('a review decision adds one review spawn per hard file, after the check and not instead of it', async () => {
  const gate = {
    byPath: {
      'src/a.ts': HARD_SHORT,
      'src/b.ts': HARD_LONG,
    },
    verify: null,
  }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test', gate },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : (o.label.startsWith('review:') ? { correct: true, reasoning: 'ok' } : { changed: true, summary: 'done' }),
  )
  assert.deepEqual(opts.map((o) => o.label), [
    'migrate:src/a.ts', 'migrate:src/b.ts', 'check:npm test', 'review:src/b.ts',
  ])
  const review = opts.find((o) => o.label === 'review:src/b.ts')
  assert.deepEqual([review.agentType, review.model, review.effort], ['kelpie:verifier', 'opus', 'xhigh'])
  assert.equal(review.phase, 'Review')
  // Hard but short gets no review spawn, so sonnet's work there stands on the executable check alone.
  assert.deepEqual([opts[0].model, opts[0].effort], ['sonnet', 'high'])
})

test('a review that fails flags its file even though the check passed', async () => {
  const gate = { byPath: { 'src/b.ts': HARD_LONG }, verify: null }
  const { result } = await runWorkflow('migrate-in-parallel', {
    args: { paths: ['src/b.ts'], transformation: 't', checkCommand: 'npm test', gate },
    respond: ({ opts: o }) => {
      if (o.label.startsWith('check:')) return { passing: true, output: '', failingPaths: [] }
      if (o.label.startsWith('review:')) return { correct: false, reasoning: 'the change breaks an invariant no test asserts on' }
      return { changed: true, summary: 'done' }
    },
  })
  assert.equal(result.check.passing, true)
  assert.deepEqual(result.flagged.map((r) => r.path), ['src/b.ts'], 'a passing check does not clear a hard item')
  assert.equal(result.reviewed[0].verified, false)
  assert.match(result.reviewed[0].reasoning, /invariant/)
})

test('no review decision means no review spawn at all, which is the measured default', async () => {
  // The 74.8% null: a verifier on top of a passing check found nothing across 20 migration trials.
  const gate = { byPath: { 'src/a.ts': { agentType: 'kelpie:mech-executor', model: 'haiku', effort: null, review: null } }, verify: null }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts'], transformation: 't', checkCommand: 'npm test', gate },

    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual(opts.map((o) => o.label), ['migrate:src/a.ts', 'check:npm test'])
})

test('with no executable check, a hard file is verified at the review tier rather than the verifier pin', async () => {
  const gate = {
    byPath: {
      'src/a.ts': { agentType: 'kelpie:mech-executor', model: 'haiku', effort: null, review: null },
      'src/b.ts': HARD_LONG,
    },
    verify: null,
  }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', gate },
    ({ opts: o }) => o.label.startsWith('verify:') ? { correct: true, reasoning: 'ok' } : { changed: true, summary: 'done' },
  )
  const verifiers = opts.filter((o) => o.label.startsWith('verify:'))
  assert.deepEqual(verifiers.map((o) => [o.label, o.agentType, o.model, o.effort]), [
    ['verify:src/a.ts', 'kelpie:verifier', undefined, undefined],
    ['verify:src/b.ts', 'kelpie:verifier', 'opus', 'xhigh'],
  ])
})

test("audit-many-files judges a hard file's findings at the review tier, not the stage tier", async () => {
  const gate = {
    byPath: {
      'src/a.ts': { agentType: null, model: 'haiku', effort: null, review: null },
      'src/b.ts': HARD_LONG,
    },
    verify: { agentType: 'kelpie:verifier', model: 'haiku', effort: null },
  }
  const opts = await optsWithoutGate(
    'audit-many-files',
    { paths: ['src/a.ts', 'src/b.ts'], concern: 'c', gate },
    ({ opts: o }) => o.label.startsWith('audit:')
      ? { findings: [{ line: 1, description: 'one' }] }
      : { confirmed: true, reasoning: 'checked' },
  )
  const verifiers = opts.filter((o) => o.label.startsWith('verify:'))
  assert.deepEqual(verifiers.map((o) => [o.label, o.model, o.effort]), [
    ['verify:src/a.ts', 'haiku', undefined],
    ['verify:src/b.ts', 'opus', 'xhigh'],
  ])
})

test('a gate with no review field anywhere behaves exactly as before it existed', async () => {
  // Backwards compatibility: a decision written by an older gate has no `review` key at all.
  const gate = { byPath: { 'src/a.ts': { agentType: 'kelpie:mech-executor', model: 'haiku', effort: 'low' } }, verify: null }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts'], transformation: 't', checkCommand: 'npm test', gate },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual(opts.map((o) => o.label), ['migrate:src/a.ts', 'check:npm test'])
})

test('a hard but short file gets no review spawn, so sonnet stands on the check alone', async () => {
  const gate = { byPath: { 'src/a.ts': HARD_SHORT, 'src/b.ts': HARD_SHORT }, verify: null }
  const opts = await optsWithoutGate(
    'migrate-in-parallel',
    { paths: ['src/a.ts', 'src/b.ts'], transformation: 't', checkCommand: 'npm test', gate },
    ({ opts: o }) => o.label.startsWith('check:') ? { passing: true, output: '' } : { changed: true, summary: 'done' },
  )
  assert.deepEqual(opts.map((o) => o.label), ['migrate:src/a.ts', 'migrate:src/b.ts', 'check:npm test'])
})
