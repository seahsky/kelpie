// What prefer mode does before it answers: ask Jev about the prompt, then name a route.
//
// Why this exists. The triage's signal families are keyword detectors. They are cheap and they run on every prompt,
// and what they can tell you is whether a prompt is shaped like a fan-out, not whether this particular job is
// cheaper split up than done in one place. On kelpie's own paired A/B the difference was total: ten real tickets in
// prefer mode scored zero on every family, so the triage said nothing on all ten, and the arm measured the plugin
// sitting in the system prompt. A bar low enough to fire on those prompts fires on every prompt, which buys the
// 6.37x with none of the reason. Neither setting of a keyword bar is the answer, because the question is not about
// the words.
//
// So in prefer mode the keyword score stops being the gate. It is still computed and still logged, because it is
// what the other modes run on and a disagreement between it and Jev is worth being able to read. The decision is
// Jev's, over five questions asked in one call: does splitting this cost less, is it read-only, is it fully
// specified, how hard is it, and is it a long job. The last two are the same difficulty and review gates the spawn
// gate already runs, entered one step earlier, so a prompt-level route and a per-file route cannot drift apart.
//
// What this costs, stated plainly because it is the reason the setting exists. With it on, the text of every prompt
// the triage reads is POSTed to api.typesafe.ai before the turn starts, and the turn waits for the answer. The
// budget below is what bounds that wait, and every request is logged with its size and hash whether or not it is
// answered.
//
// Nothing here may fail a turn. Any error, timeout, or unreadable answer returns no route, and the caller then falls
// back to prefer mode's own note, which is what prefer mode said before this existed. Failing towards silence would
// be the wrong direction: the user has asked for a decision on every prompt, and a third party being down is not a
// reason to stop deciding.

import { JEV_MODEL, JEV_URL, askJev, promptRequest } from '../jev-gate/jev.mjs'
import { MODELS_WITHOUT_EFFORT, ROLE_EXPLORE, ROLE_GENERAL, ROLE_MECH, ROLE_VERIFIER, STAGES, applyPromptFloor, clampDecision, decidePrompt, modelCeiling } from '../jev-gate/policy.mjs'
import { countPaths } from './signals.mjs'
import { fingerprint } from '../log.mjs'
import { num, str } from '../env.mjs'

/**
 * How long the turn may wait, end to end.
 *
 * Six seconds against published per-call timings of 0.09 s to 0.31 s. The margin is there because those figures are
 * one cookbook run rather than a latency commitment, and because this call carries five questions. Two attempts
 * inside the budget, so one lost packet is survivable and a dead endpoint is not waited on three times.
 */
export const DEFAULT_BUDGET_MS = 6000
export const DEFAULT_REQUEST_MS = 3000
export const MAX_ATTEMPTS = 2

/** Effort is capped where the spawn gate caps it. A triage may not route a spawn past what the gate would allow. */
export const EFFORT_CEILING = 'xhigh'

export const settings = ({ env = {} } = {}) => ({
  apiKey: str(env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY, ''),
  url: str(env.KELPIE_GATE_JEV_URL, JEV_URL),
  jevModel: str(env.KELPIE_GATE_JEV_MODEL, JEV_MODEL),
  budgetMs: num(env.KELPIE_TRIAGE_BUDGET_MS, DEFAULT_BUDGET_MS),
  requestMs: num(env.KELPIE_TRIAGE_REQUEST_MS, DEFAULT_REQUEST_MS),
  confidenceFloor: num(env.KELPIE_GATE_CONFIDENCE_FLOOR, 0.6),
  effortCeiling: str(env.KELPIE_GATE_EFFORT_CEILING, EFFORT_CEILING),
})

/**
 * Ask about one prompt, and return the route or null.
 *
 * `record` is the caller's logger, so the triage's decision and the call that informed it land on adjacent lines of
 * one file. `sessionModel` may be null: see decidePrompt for why that names a route with no model rather than no
 * route at all.
 */
export const consult = async ({ prompt, sessionModel = null, env = {}, record = () => {}, verbosity = { prompts: false }, fetchImpl = undefined, now = () => Date.now() }) => {
  const config = settings({ env })
  const task = typeof prompt === 'string' ? prompt : ''
  const ceilings = { model: modelCeiling(sessionModel), effort: config.effortCeiling }
  const request = promptRequest({ task, pathsNamed: countPaths(task), model: config.jevModel })
  const sent = request.state.task
  // Logged before it goes, for the same reason the spawn gate logs a file excerpt before it goes: this is a hook
  // uploading something the user did not choose to upload, from before the point where the turn could be declined.
  record({
    event: 'jev_request',
    stage: STAGES.PROMPT,
    path: null,
    url: config.url,
    jev_model: request.model,
    questions: Object.keys(request.questions),
    state_keys: Object.keys(request.state),
    paths_named: request.state.paths_named,
    excerpt_chars: sent.length,
    excerpt_sha256: fingerprint(sent),
    ...(verbosity.prompts ? { task: sent } : {}),
  })
  const started = now()
  const deadline = started + config.budgetMs
  try {
    const answers = await askJev({
      request,
      apiKey: config.apiKey,
      url: config.url,
      perRequestTimeoutMs: Math.min(config.requestMs, Math.max(deadline - now(), 1)),
      maxAttempts: MAX_ATTEMPTS,
      ...(fetchImpl ? { fetchImpl } : {}),
      onAttempt: (attempt) => record({ event: 'jev_attempt', stage: STAGES.PROMPT, path: null, ...attempt }),
    })
    const floored = applyPromptFloor(decidePrompt(answers, ceilings), answers, config.confidenceFloor)
    const decision = clampDecision(floored, ceilings)
    record({ event: 'jev_decision', stage: STAGES.PROMPT, path: null, ms: now() - started, asked: true, answers, ceilings, decision })
    // Only an unsure decisive answer lands here. An unsure tier keeps the route and names no model, which is the
    // difference between declining a rung and declining to answer. See applyPromptFloor.
    return decision.delegate === null ? null : decision
  } catch (error) {
    // Covers both a call that did not come back and an answer that came back unreadable, because either way no route
    // was established and the caller does the same thing about it.
    const reason = `no route from jev: ${error && error.message ? error.message : String(error)}`
    record({ event: 'jev_decision', stage: STAGES.PROMPT, path: null, ms: now() - started, asked: true, answers: null, ceilings, reason, decision: null })
    return null
  }
}

/** "model sonnet, effort medium", or what to say when a field is deliberately unset. */
const tier = ({ model, effort }) => {
  if (model === null && effort === null) return "at this session's own model and effort"
  if (model === null) return `at this session's model, effort ${effort}`
  if (effort === null) {
    return MODELS_WITHOUT_EFFORT.has(model) ? `model ${model}, which takes no effort parameter` : `model ${model}`
  }
  return `model ${model}, effort ${effort}`
}

const routeLine = (decision) => {
  if (decision.agentType === ROLE_EXPLORE) {
    return `- Send it to the built-in Explore agent, ${tier(decision)}: ${decision.reason}. You want the conclusion, not the file dumps.`
  }
  if (decision.agentType === ROLE_GENERAL) {
    return `- ${decision.precondition}, then hand the rest to general-purpose, ${tier(decision)}: ${decision.reason}. Nothing measured supports handing an open decision to a cheaper tier.`
  }
  return `- Spawn ${ROLE_MECH}, ${tier(decision)}: ${decision.reason}.`
}

const SPEC = '- Spec it in one shot: exact file paths, exact symbol names, acceptance criteria, and why the work matters. A subagent cannot ask you a question mid-task.'

const reviewLine = (review) => `- Then have ${ROLE_VERIFIER} check the result, ${tier(review)}. Where a test, type check, lint, or build settles the question, run that first and skip this: a verifier stage over 20 migration trials found nothing the check had not already named and took 74.8% of the arm's cost.`

const STANDING = '- Security-sensitive work stays in this session whatever this says. Opus has been observed refusing delegated security tasks that it accepts inline.'

/**
 * The note for a decided route.
 *
 * It names the route and the answer behind it, rather than restating the policy. That is the point of asking: prefer
 * mode's own note is a list of routes the model then has to choose between, and a list of options on every prompt is
 * how the first run ended with a note delivered thirteen times and referenced zero times.
 */
export const renderRoute = (decision) => {
  const header = `kelpie delegation triage (prefer mode), decided with jev: ${decision.delegate ? 'delegate this.' : 'keep this in this session.'}`
  const lines = [header, '']
  if (decision.delegate) {
    lines.push(`Splitting the work costs less than doing all of it in this session (delegation_saves ${decision.saves}).`)
    lines.push(routeLine(decision))
    if (decision.agentType !== ROLE_EXPLORE) lines.push(SPEC)
  } else {
    lines.push(`${decision.reason.charAt(0).toUpperCase()}${decision.reason.slice(1)}.`)
    lines.push('- Prefer mode delegates by default. This is a prompt where it does not, so do the work here.')
  }
  if (decision.review) lines.push(reviewLine(decision.review))
  lines.push(STANDING)
  return lines.join('\n')
}
