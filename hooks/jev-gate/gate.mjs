#!/usr/bin/env node
// kelpie's optional spawn gate: a PreToolUse hook on the Workflow tool.
//
// It decides each spawn's role, model, and reasoning effort per item, instead of taking the one pinned answer in each
// role's frontmatter. It is off unless a Jev API key is configured, and with no key it emits nothing at all, so
// kelpie behaves exactly as it does without it.
//
// Why this tool and not the Agent tool. Measured in kelpie's Stage 2 run, its role spawns all happen
// inside workflow scripts. Those spawns fire SubagentStart, which cannot block, and never reach PreToolUse; workflow
// scripts also run in a vm context with no network, so a script cannot ask anything. The Workflow tool call itself is
// an ordinary tool call, so PreToolUse sees it, and its `args` already name the work: both workflows take
// `args.paths`. So the gate decides here and writes its decisions into `args.gate`, which the workflows read. That is
// the only reachable point that can set all three: the Agent tool's input schema has no effort parameter, and
// workflow `agent()` opts does.
//
// Which rungs are on offer is decided here, before anything is asked of Jev, from the session's own model:
// haiku/sonnet/opus below an opus or fable session, haiku/sonnet below a sonnet one. A fable session is the case with
// the most to win, because opus is a rung below it, so its hard spawns come down instead of staying on the priciest
// model on offer. Jev is asked only about the work, never about which model should run it.
//
// The gate must never change the behaviour it is meant to improve. Any failure, timeout, or unexpected shape falls
// back to the pin the workflow already had, and an unexpected error emits nothing and leaves the call untouched.
// A session model that cannot be established is one of those failures: with no known ceiling the gate cannot show
// that a route is downward, so it emits nothing and records why.

import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { STAGES, applyConfidenceFloor, availableModels, clampDecision, decideFanout, decideVerify, modelCeiling, staticDecision } from './policy.mjs'
import { JEV_MODEL, JEV_URL, askJev, fanoutRequest, verifyRequest } from './jev.mjs'
import { fingerprint, logger, resolveLogPath, resolveVerbosity } from '../log.mjs'
import { num, str } from '../env.mjs'
import { resolveSession } from './session.mjs'

const env = process.env
// The key is a plugin option, so Claude Code hands it to this hook as CLAUDE_PLUGIN_OPTION_JEV_API_KEY and keeps the
// value itself in the OS keychain rather than in settings.json. A plugin hook cannot read `${user_config.*}` from a
// shell-form command, by design, so reading it from the environment is the supported way in.
const API_KEY = env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY ?? ''
// `off` means emit nothing, which is what an unconfigured kelpie does. `static` decides from the shipped pins without
// calling anything, and exists so a benchmark can separate "the gate ran" from "Jev answered"; it is not a user mode.
const MODE = env.KELPIE_GATE_MODE || (API_KEY ? 'jev' : 'off')
// Empty means "read it from the session", which is the path a real install takes. A benchmark arm sets it, because an
// arm's main session model is a fact of the schedule and should not depend on parsing a transcript.
const MODEL_CEILING_OVERRIDE = env.KELPIE_GATE_MODEL_CEILING ?? ''
const EFFORT_CEILING = str(env.KELPIE_GATE_EFFORT_CEILING, 'xhigh')
const CONFIDENCE_FLOOR = num(env.KELPIE_GATE_CONFIDENCE_FLOOR, 0.6)
const BUDGET_MS = num(env.KELPIE_GATE_BUDGET_MS, 45000)
const REQUEST_MS = num(env.KELPIE_GATE_REQUEST_MS, 5000)
// Sized against the documented 1,200 requests per minute for jev-1.13.0: at the slow end of the published cookbook
// timings (0.31 s), two in flight is about 400 requests per minute, leaving room for other sessions on the same key.
const CONCURRENCY = num(env.KELPIE_GATE_CONCURRENCY, 2)
// Overridable so the gate can be tested end to end against a local server without reaching TypeSafe.
const API_URL = str(env.KELPIE_GATE_JEV_URL, JEV_URL)
const API_MODEL = str(env.KELPIE_GATE_JEV_MODEL, JEV_MODEL)

// KELPIE_GATE_LOG still wins where it is set, because configurations use it. KELPIE_LOG and the config file's `log`
// key put the gate's calls and the triage's decisions in one file, which is where they are worth reading together.
const VERBOSITY = resolveVerbosity({ env })
// Bound from the environment at load so a failure before the event is parsed is still recorded, then rebound once
// the event names a working directory, since a project-scoped log path can only be found from there.
let record = logger({ path: resolveLogPath({ env, override: env.KELPIE_GATE_LOG ?? '' }).path, base: { hook: 'jev-gate' } })

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Which shipped workflow this call is, read from the shape of its args rather than from a name that may be spelled several ways. */
const classify = (args) => {
  if (!args || !Array.isArray(args.paths) || args.paths.length === 0) return null
  if (typeof args.concern === 'string') return 'audit'
  if (typeof args.transformation === 'string') return 'migrate'
  return null
}

/** Run thunks with a concurrency cap, so a 20-path workflow does not open 20 sockets at once. */
const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * What this call is about to put on the wire, recorded before it goes.
 *
 * The gate's one genuinely consequential side effect is that it uploads an excerpt of a file from the user's
 * repository to a third party, from a PreToolUse hook, before the user can decline the call. So the path, the size
 * and a hash of exactly what was sent are logged whether or not the call then succeeds. The excerpt's own text is
 * written only when `KELPIE_LOG_EXCERPTS` asks for it, because a log of repository contents is repository contents.
 */
const recordRequest = ({ stage, path, request }) => {
  const sent = request?.state?.file_excerpt
  record({
    event: 'jev_request',
    stage,
    path,
    url: API_URL,
    jev_model: request?.model ?? null,
    questions: Object.keys(request?.questions ?? {}),
    state_keys: Object.keys(request?.state ?? {}),
    file_line_count: request?.state?.file_line_count ?? null,
    excerpt_chars: typeof sent === 'string' ? sent.length : null,
    excerpt_lines: typeof sent === 'string' ? sent.split('\n').length : null,
    excerpt_sha256: fingerprint(sent),
    ...(VERBOSITY.excerpts && typeof sent === 'string' ? { file_excerpt: sent } : {}),
  })
}

const askOrFallback = async ({ stage, request, apiKey, decide, deadline, path = null }) => {
  const started = Date.now()
  if (Date.now() > deadline) {
    const decision = { ...staticDecision(stage), source: 'fallback', reason: 'gate budget spent' }
    record({ event: 'jev_decision', stage, path, ms: 0, asked: false, reason: decision.reason, decision })
    return { decision, ms: 0, answers: null }
  }
  recordRequest({ stage, path, request })
  try {
    const answers = await askJev({
      request,
      apiKey,
      url: API_URL,
      perRequestTimeoutMs: Math.min(REQUEST_MS, deadline - Date.now()),
      onAttempt: (attempt) => record({ event: 'jev_attempt', stage, path, ...attempt }),
    })
    const decided = applyConfidenceFloor(stage, decide(answers), answers, CONFIDENCE_FLOOR)
    record({ event: 'jev_decision', stage, path, ms: Date.now() - started, asked: true, answers, decision: decided })
    return { decision: decided, ms: Date.now() - started, answers }
  } catch (error) {
    const reason = `jev unavailable: ${error && error.message ? error.message : String(error)}`
    const decision = { ...staticDecision(stage), source: 'fallback', reason }
    record({ event: 'jev_decision', stage, path, ms: Date.now() - started, asked: true, answers: null, reason, decision })
    return { decision, ms: Date.now() - started, answers: null }
  }
}

/**
 * Read a file, but only if it is really inside `cwd`.
 *
 * `args.paths` is written by the model, so it is not a scoped list: it can name an absolute path, or walk out with
 * `../`. `resolve()` on its own does not constrain anything — it drops every preceding segment the moment it meets an
 * absolute path, so `resolve('/repo', '/home/you/.ssh/id_rsa')` is that key. Every file this reads is sent to the API
 * in `state.file_excerpt`, so an unconstrained read here is an unconstrained upload, and it happens in a PreToolUse
 * hook, which is before the user can decline the call.
 *
 * The comparison is on real paths rather than resolved ones, because a symlink inside the repo pointing outside it
 * passes a `startsWith` test on the unresolved path and fails this one.
 *
 * Returns `{ contents }` on success, or `{ reason }` naming why the file was skipped.
 */
const readInside = (cwd, path) => {
  let base
  try {
    base = realpathSync(cwd)
  } catch {
    return { reason: 'cwd unresolvable' }
  }
  let target
  try {
    target = realpathSync(resolve(base, path))
  } catch {
    return { reason: 'file unreadable' }
  }
  if (target !== base && !target.startsWith(base + sep)) return { reason: 'file outside cwd' }
  try {
    return { contents: readFileSync(target, 'utf8') }
  } catch {
    return { reason: 'file unreadable' }
  }
}

const gateAudit = async ({ args, cwd, apiKey, deadline, ceilings }) => {
  const fanoutStage = STAGES.AUDIT_FIND
  const perPath = await mapLimit(args.paths, CONCURRENCY, async (path) => {
    if (MODE !== 'jev') return { path, ...{ decision: staticDecision(fanoutStage), ms: 0, answers: null } }
    const read = readInside(cwd, path)
    if (read.reason) {
      // A refused read is a file that was named and not uploaded, which is the containment check doing its job.
      record({ event: 'file_skipped', stage: fanoutStage, path, reason: read.reason })
      return { path, decision: { ...staticDecision(fanoutStage), source: 'fallback', reason: read.reason }, ms: 0, answers: null }
    }
    const request = fanoutRequest({ work: args.concern, path, contents: read.contents, model: API_MODEL })
    return { path, ...(await askOrFallback({ stage: fanoutStage, request, apiKey, path, decide: (a) => decideFanout(fanoutStage, a, ceilings), deadline })) }
  })
  const verify = MODE !== 'jev'
    ? { decision: staticDecision(STAGES.AUDIT_VERIFY), ms: 0, answers: null }
    : await askOrFallback({
      stage: STAGES.AUDIT_VERIFY,
      request: verifyRequest({ concern: args.concern, pathCount: args.paths.length, model: API_MODEL }),
      apiKey,
      decide: decideVerify,
      deadline,
    })
  return {
    byPath: Object.fromEntries(perPath.map((r) => [r.path, clampDecision(r.decision, ceilings)])),
    verify: clampDecision(verify.decision, ceilings),
    calls: [...perPath.map((r) => ({ stage: fanoutStage, path: r.path, ms: r.ms, answers: r.answers, decision: r.decision })),
      { stage: STAGES.AUDIT_VERIFY, path: null, ms: verify.ms, answers: verify.answers, decision: verify.decision }],
  }
}

const gateMigrate = async ({ args, cwd, apiKey, deadline, ceilings }) => {
  const stage = STAGES.MIGRATE_APPLY
  const perPath = await mapLimit(args.paths, CONCURRENCY, async (path) => {
    if (MODE !== 'jev') return { path, decision: staticDecision(stage), ms: 0, answers: null }
    const read = readInside(cwd, path)
    if (read.reason) {
      record({ event: 'file_skipped', stage, path, reason: read.reason })
      return { path, decision: { ...staticDecision(stage), source: 'fallback', reason: read.reason }, ms: 0, answers: null }
    }
    const request = fanoutRequest({ work: args.transformation, path, contents: read.contents, model: API_MODEL })
    return { path, ...(await askOrFallback({ stage, request, apiKey, path, decide: (a) => decideFanout(stage, a, ceilings), deadline })) }
  })
  return {
    byPath: Object.fromEntries(perPath.map((r) => [r.path, clampDecision(r.decision, ceilings)])),
    verify: null,
    calls: perPath.map((r) => ({ stage, path: r.path, ms: r.ms, answers: r.answers, decision: r.decision })),
  }
}

const main = async () => {
  const event = JSON.parse(await readStdin())
  record = logger({
    path: resolveLogPath({ env, cwd: event.cwd ?? '', override: env.KELPIE_GATE_LOG ?? '' }).path,
    base: { hook: 'jev-gate', session_id: event.session_id ?? null, cwd: event.cwd ?? null },
  })
  if (event.tool_name !== 'Workflow') return null
  // The default for an unconfigured kelpie. Emitting nothing leaves the Workflow call exactly as the model wrote it,
  // and the workflows then use the pins in their roles' frontmatter, which is kelpie's behaviour without a gate.
  if (MODE === 'off') return null
  const toolInput = event.tool_input ?? {}
  const args = toolInput.args
  const kind = classify(args)
  if (kind === null) {
    record({ event: 'skipped', reason: 'args name no gateable workflow', mode: MODE })
    return null
  }
  if (MODE === 'jev' && !API_KEY) {
    // Asked for Jev with no key: every call will fall back, which looks exactly like the static policy. Say so,
    // because a benchmark arm that silently becomes another arm is worse than one that fails.
    record({ event: 'misconfigured', reason: 'KELPIE_GATE_MODE=jev with no jev_api_key plugin option', mode: MODE })
  }
  // The ceiling is the session's own model, because the gate's one hard promise is that it never routes a spawn above
  // it. A fable session's ceiling is opus, the rung below fable, so its hard spawns come down a rung instead of
  // staying on the most expensive model in the ladder.
  const session = resolveSession({ transcriptPath: event.transcript_path, effortLevel: event.effort?.level, env })
  const ceiling = MODEL_CEILING_OVERRIDE || session.model
  const ceilings = { model: modelCeiling(ceiling), effort: EFFORT_CEILING }
  if (MODE === 'jev' && ceilings.model === null) {
    // No known ceiling, so no route can be shown to be downward. Emitting nothing leaves every frontmatter pin in
    // place, which is the configuration the benchmark measured.
    record({ event: 'skipped', reason: `session model unresolved (saw ${JSON.stringify(ceiling)})`, mode: MODE })
    return null
  }
  const deadline = Date.now() + BUDGET_MS
  const cwd = event.cwd ?? process.cwd()
  const gated = kind === 'audit'
    ? await gateAudit({ args, cwd, apiKey: API_KEY, deadline, ceilings })
    : await gateMigrate({ args, cwd, apiKey: API_KEY, deadline, ceilings })

  record({
    event: 'gated',
    mode: MODE,
    kind,
    ceilings,
    session_model: session.model,
    session_effort: session.effort,
    // Recorded so a later stage can tell a gate that had one rung to choose from apart from one that had three.
    available_models: availableModels(ceilings.model),
    confidence_floor: CONFIDENCE_FLOOR,
    jev_model: API_MODEL,
    session_id: event.session_id ?? null,
    calls: gated.calls,
  })

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `kelpie stage 4 gate (${MODE}): ${gated.calls.length} decision(s)`,
      updatedInput: { ...toolInput, args: { ...args, gate: { byPath: gated.byPath, verify: gated.verify } } },
    },
  }
}

main()
  .then((output) => {
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`)
    process.exit(0)
  })
  .catch((error) => {
    // Emitting nothing leaves the Workflow call exactly as the model wrote it.
    record({ event: 'error', mode: MODE, message: String(error && error.message ? error.message : error) })
    process.exit(0)
  })
