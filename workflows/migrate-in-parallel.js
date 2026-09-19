// Each spawn below can be redirected by kelpie's optional spawn gate (hooks/jev-gate/). The gate runs as a PreToolUse
// hook on the Workflow tool, so it sees this call's `args` before the script runs, and writes a per-item decision into
// `args.gate`. With no gate configured there is no `args.gate`, and every spawn keeps the role and the frontmatter pins
// it has always had. tests/workflows.test.mjs pins that ungated behaviour exactly, so the gate cannot change it.
export const meta = {
  name: 'migrate-in-parallel',
  description: 'Apply the same fully-specified transformation across many files, then settle correctness with one executable check',
  phases: [{ title: 'Migrate' }, { title: 'Verify' }, { title: 'Review' }],
}

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    changed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['changed', 'summary'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    passing: { type: 'boolean' },
    output: { type: 'string' },
    failingPaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['passing', 'output'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    correct: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['correct', 'reasoning'],
}

if (!args || !Array.isArray(args.paths) || args.paths.length === 0) {
  throw new Error('migrate-in-parallel requires args.paths: an array of file paths to migrate')
}
if (!args.transformation) {
  throw new Error('migrate-in-parallel requires args.transformation: a fully-specified description of the change to apply')
}
// Two agents editing the same file in parallel would overwrite each other's work.
const normalizedPaths = args.paths.map((p) => p.replace(/^(\.\/)+/, ''))
const duplicatePaths = [...new Set(normalizedPaths.filter((p, i) => normalizedPaths.indexOf(p) !== i))]
if (duplicatePaths.length > 0) {
  throw new Error(`migrate-in-parallel requires unique args.paths; duplicates: ${duplicatePaths.join(', ')}`)
}

const gate = args.gate || null
// A decision's agentType of null means the session tier on purpose, so "decision present" and "field set" are
// different questions. With no decision at all, the shipped default stands untouched.
const withGate = (opts, decision, shippedAgentType) => {
  const agentType = decision ? decision.agentType : shippedAgentType
  if (agentType) opts.agentType = agentType
  if (decision && decision.model) opts.model = decision.model
  if (decision && decision.effort) opts.effort = decision.effort
  return opts
}

/** The tier the gate named for reviewing this path's change, or null when it asked for no review. */
const reviewTierFor = (path) => {
  const decision = gate && gate.byPath ? gate.byPath[path] : null
  return decision && decision.review ? decision.review : null
}

/**
 * One independent read of each item the gate rated hard, at the tier it named.
 *
 * This is additional to the executable check below, never a replacement for it. The two settle different questions:
 * the check catches what the test suite asserts on, and this catches what it does not. Only the items the gate
 * singled out get one, so an ordinary mechanical migration spawns none of these at all and costs exactly what it did
 * before. Returns an empty list when no gate is configured.
 */
const reviewHardItems = async (items) => {
  const toReview = items.filter((r) => reviewTierFor(r.path))
  if (toReview.length === 0) return []
  phase('Review')
  log(`${toReview.length} of ${items.length} changed file(s) were rated hard, so each gets one independent review`)
  const verdicts = await parallel(toReview.map((r) => () =>
    agent(
      `${r.path} was just migrated. Intended transformation: ${args.transformation}. Reported change: "${r.summary}". This file was rated as one where applying the change correctly needs reasoning about behaviour the file does not state on its face, so a passing test suite does not settle it. Read the file and judge whether the change is actually correct, paying attention to anything it alters that no test asserts on. Report correct:false if you cannot confirm it.`,
      withGate({ phase: 'Review', schema: VERDICT_SCHEMA, label: `review:${r.path}` }, reviewTierFor(r.path), 'kelpie:verifier')
    ).then((v) => ({ ...r, verified: !!v?.correct, reasoning: v?.reasoning }))
  ))
  return verdicts.filter(Boolean)
}

phase('Migrate')
const results = await parallel(args.paths.map((path) => () =>
  agent(
    `Apply this transformation to ${path}, and only this file: ${args.transformation}. If the file doesn't match the pattern this transformation targets, make no change and report changed:false with why. Otherwise make the change and report changed:true with a one-sentence summary of what you changed.`,
    withGate({ phase: 'Migrate', schema: CHANGE_SCHEMA, label: `migrate:${path}` }, gate && gate.byPath ? gate.byPath[path] : null, 'kelpie:mech-executor')
  ).then((r) => ({ path, changed: !!r?.changed, summary: r?.summary || '' }))
))

const changed = results.filter(Boolean).filter((r) => r.changed)
log(`${changed.length}/${args.paths.length} file(s) changed`)
if (changed.length === 0) {
  return { pathsConsidered: args.paths.length, changed: [], flagged: [], check: null }
}

phase('Verify')
// One executable check beats one verifier agent per file, so the gate is never asked about this stage. Measured on
// kelpie's Stage 2 run: across 20 migration trials the project's own test command surfaced every behaviour-breaking
// failure first, naming the failing file, and the per-file verifier stage that ran on top of it found nothing new
// while taking 74.8% of the arm's cost.
if (args.checkCommand) {
  const check = await agent(
    `Run this exact command and report what happened: \`${args.checkCommand}\`. Do not fix anything, do not edit any file, and do not re-run with different arguments. Report passing:true only if the command exited successfully. Put the relevant failure output in \`output\`, and list any file paths the failures name in \`failingPaths\`.`,
    { phase: 'Verify', schema: CHECK_SCHEMA, label: `check:${args.checkCommand}` }
  )
  const failingPaths = check?.failingPaths ?? []
  const flagged = changed.filter((r) => failingPaths.some((f) => r.path.endsWith(f) || f.endsWith(r.path)))
  log(check?.passing ? `check passed: ${args.checkCommand}` : `check FAILED: ${args.checkCommand}`)
  const flaggedByCheck = check?.passing ? [] : (flagged.length > 0 ? flagged : changed)
  // A passing check does not clear an item the gate rated hard, so the review runs either way and can flag on its own.
  const reviewed = await reviewHardItems(changed)
  const flaggedPaths = new Set([...flaggedByCheck, ...reviewed.filter((r) => !r.verified)].map((r) => r.path))
  if (reviewed.length > 0) {
    log(`${reviewed.filter((r) => r.verified).length} of ${reviewed.length} reviewed file(s) confirmed correct`)
  }
  return {
    pathsConsidered: args.paths.length,
    changed,
    flagged: changed.filter((r) => flaggedPaths.has(r.path)),
    reviewed,
    check: { command: args.checkCommand, passing: !!check?.passing, output: check?.output || '' },
  }
}

// No executable check available, so fall back to per-file adversarial verification — the expensive path, on purpose.
log('no args.checkCommand given; falling back to one verifier per changed file, which costs far more than a test run')
// Every changed file is verified here whatever the gate said, because with no check there is nothing else. A path the
// gate rated hard is verified at the review tier it named, which is a raise over the verifier's own pin.
const verdicts = await parallel(changed.map((r) => () =>
  agent(
    `${r.path} was just migrated. Intended transformation: ${args.transformation}. Reported change: "${r.summary}". Read the file and confirm the change was actually applied correctly and didn't break anything obviously adjacent to it.`,
    withGate({ phase: 'Verify', schema: VERDICT_SCHEMA, label: `verify:${r.path}` }, reviewTierFor(r.path), 'kelpie:verifier')
  ).then((v) => ({ ...r, verified: !!v?.correct, reasoning: v?.reasoning }))
))

const judged = verdicts.filter(Boolean)
const flagged = judged.filter((r) => !r.verified)
log(`${judged.length - flagged.length} verified correct, ${flagged.length} flagged for review`)
return { pathsConsidered: args.paths.length, changed: judged, flagged, check: null }
