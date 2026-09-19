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

import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STAGES, applyConfidenceFloor, availableModels, clampDecision, decideFanout, decideVerify, modelCeiling, staticDecision } from './policy.mjs'
import { JEV_MODEL, JEV_URL, askJev, fanoutRequest, verifyRequest } from './jev.mjs'
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
const EFFORT_CEILING = env.KELPIE_GATE_EFFORT_CEILING ?? 'xhigh'
const CONFIDENCE_FLOOR = Number(env.KELPIE_GATE_CONFIDENCE_FLOOR ?? '0.6')
const BUDGET_MS = Number(env.KELPIE_GATE_BUDGET_MS ?? '45000')
const REQUEST_MS = Number(env.KELPIE_GATE_REQUEST_MS ?? '5000')
// Sized against the documented 1,200 requests per minute for jev-1.13.0: at the slow end of the published cookbook
// timings (0.31 s), two in flight is about 400 requests per minute, leaving room for other sessions on the same key.
const CONCURRENCY = Number(env.KELPIE_GATE_CONCURRENCY ?? '2')
const LOG_PATH = env.KELPIE_GATE_LOG ?? ''
// Overridable so the gate can be tested end to end against a local server without reaching TypeSafe.
const API_URL = env.KELPIE_GATE_JEV_URL ?? JEV_URL
const API_MODEL = env.KELPIE_GATE_JEV_MODEL ?? JEV_MODEL

const record = (entry) => {
  if (!LOG_PATH) return
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`)
  } catch {
    // A gate that fails because it could not write its own log would change the arm. Losing the log is the lesser harm.
  }
}

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

const askOrFallback = async ({ stage, request, apiKey, decide, deadline }) => {
  const started = Date.now()
  if (Date.now() > deadline) {
    return { decision: { ...staticDecision(stage), source: 'fallback', reason: 'gate budget spent' }, ms: 0, answers: null }
  }
  try {
    const answers = await askJev({ request, apiKey, url: API_URL, perRequestTimeoutMs: Math.min(REQUEST_MS, deadline - Date.now()) })
    const decided = applyConfidenceFloor(stage, decide(answers), answers, CONFIDENCE_FLOOR)
    return { decision: decided, ms: Date.now() - started, answers }
  } catch (error) {
    const reason = `jev unavailable: ${error && error.message ? error.message : String(error)}`
    return { decision: { ...staticDecision(stage), source: 'fallback', reason }, ms: Date.now() - started, answers: null }
  }
}

const gateAudit = async ({ args, cwd, apiKey, deadline, ceilings }) => {
  const fanoutStage = STAGES.AUDIT_FIND
  const perPath = await mapLimit(args.paths, CONCURRENCY, async (path) => {
    if (MODE !== 'jev') return { path, ...{ decision: staticDecision(fanoutStage), ms: 0, answers: null } }
    let contents = ''
    try {
      contents = readFileSync(resolve(cwd, path), 'utf8')
    } catch {
      return { path, decision: { ...staticDecision(fanoutStage), source: 'fallback', reason: 'file unreadable' }, ms: 0, answers: null }
    }
    const request = fanoutRequest({ work: args.concern, path, contents, model: API_MODEL })
    return { path, ...(await askOrFallback({ stage: fanoutStage, request, apiKey, decide: (a) => decideFanout(fanoutStage, a, ceilings), deadline })) }
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
    let contents = ''
    try {
      contents = readFileSync(resolve(cwd, path), 'utf8')
    } catch {
      return { path, decision: { ...staticDecision(stage), source: 'fallback', reason: 'file unreadable' }, ms: 0, answers: null }
    }
    const request = fanoutRequest({ work: args.transformation, path, contents, model: API_MODEL })
    return { path, ...(await askOrFallback({ stage, request, apiKey, decide: (a) => decideFanout(stage, a, ceilings), deadline })) }
  })
  return {
    byPath: Object.fromEntries(perPath.map((r) => [r.path, clampDecision(r.decision, ceilings)])),
    verify: null,
    calls: perPath.map((r) => ({ stage, path: r.path, ms: r.ms, answers: r.answers, decision: r.decision })),
  }
}

const main = async () => {
  const event = JSON.parse(await readStdin())
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
