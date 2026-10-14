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
// what the other modes run on and a disagreement between it and Jev is worth being able to read. Jev is asked five
// questions about the work in one call: is it big enough to hand over, is it read-only, is it fully specified, how
// hard is it, and is it a long job. The last two are the same difficulty and review gates the spawn gate already
// runs, entered one step earlier, so a prompt-level route and a per-file route cannot drift apart. Whether the
// cheapest model that fits is cheaper than this session's is not asked: policy.mjs computes it from the answers.
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
import { ROLE_ANALYST, ROLE_RECON, STAGES, decidePrompt } from '../jev-gate/policy.mjs'
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

// No effort ceiling here, unlike the spawn gate. A prompt-level route names no effort at all, because the Agent tool
// that carries it out takes a model and has no effort parameter. See decidePrompt.
export const settings = ({ env = {} } = {}) => ({
  apiKey: str(env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY, ''),
  url: str(env.KELPIE_GATE_JEV_URL, JEV_URL),
  jevModel: str(env.KELPIE_GATE_JEV_MODEL, JEV_MODEL),
  budgetMs: num(env.KELPIE_TRIAGE_BUDGET_MS, DEFAULT_BUDGET_MS),
  requestMs: num(env.KELPIE_TRIAGE_REQUEST_MS, DEFAULT_REQUEST_MS),
  confidenceFloor: num(env.KELPIE_GATE_CONFIDENCE_FLOOR, 0.6),
})

/**
 * Ask about one prompt, and return the route or null.
 *
 * `record` is the caller's logger, so the triage's decision and the call that informed it land on adjacent lines of
 * one file. `sessionModel` is the session's tier, or null on the first prompt of a session: see decidePrompt for why
 * that still names a route, and how the note hands the price comparison to the model.
 */
export const consult = async ({ prompt, sessionModel = null, env = {}, record = () => {}, verbosity = { prompts: false }, fetchImpl = undefined, now = () => Date.now() }) => {
  const config = settings({ env })
  const task = typeof prompt === 'string' ? prompt : ''
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
    const decision = decidePrompt(answers, { session: sessionModel, floor: config.confidenceFloor })
    record({ event: 'jev_decision', stage: STAGES.PROMPT, path: null, ms: now() - started, asked: true, answers, session_model: sessionModel, decision })
    // Only an unsure decisive answer lands here. An unsure tier moves the rung up and keeps the route, which is the
    // difference between hedging a rung and declining to answer. See decidePrompt.
    return decision.delegate === null ? null : decision
  } catch (error) {
    // Covers both a call that did not come back and an answer that came back unreadable, because either way no route
    // was established and the caller does the same thing about it.
    const reason = `no route from jev: ${error && error.message ? error.message : String(error)}`
    record({ event: 'jev_decision', stage: STAGES.PROMPT, path: null, ms: now() - started, asked: true, answers: null, session_model: sessionModel, reason, decision: null })
    return null
  }
}

/** "kelpie:mech-executor with model: sonnet", written the way the Agent tool call takes it. */
const call = ({ agentType, model }) => (model === null ? `${agentType} at this session's own model` : `${agentType} with model: ${model}`)

/**
 * The route as one instruction, in the order the work happens: what to hand over and to whom, and how to check what
 * comes back.
 *
 * Why a single imperative sentence and not the verdict with its reasons. On 2026-09-23 the route for one of kelpie's
 * benchmark tickets was mech-executor on Sonnet, and Opus 5.5 did the work itself. Replaying the ticket's opening
 * with only the note varied: the note as it was then ("A subagent on sonnet costs less than doing this here ...
 * (substantial 0.87)", "Resolve every open decision here first (fully_specified 0.07). Then hand over what is left.",
 * "Spawn kelpie:mech-executor with model: sonnet: hard (difficulty 1.77 ...)") was followed 0 times in 9, whether it
 * was conditional or not, whichever way mech-executor described itself, and when it was repeated at the first edit.
 * "Settle the design yourself, then hand the implementation to kelpie:mech-executor with model: sonnet, giving it a
 * complete spec, and review what it returns before you open the PR." was followed 4 times in 4, from this same hook
 * as well as from the user's prompt. A cost argument with scores in it reads as advice; a plan reads as the plan.
 * So the note is the plan, and the scores go to the decision log, which already records them.
 */
const plan = (decision) => {
  const to = call(decision)
  if (decision.agentType === ROLE_RECON) return `hand the lookups to ${to} and work from its report`
  if (decision.agentType === ROLE_ANALYST) {
    const check = 'as one exact question, and check its answer against the lines it cites before you rely on it'
    return decision.precondition ? `pin down the exact question yourself, then put it to ${to} ${check}` : `put the question to ${to} ${check}`
  }
  // No precondition form: decidePrompt keeps work with an open design decision in this session.
  return `hand the implementation to ${to}, giving it a complete spec, and review what it returns before you finish`
}

const capitalised = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

const reviewSentence = (review) => `Then have ${call(review)} check the result, unless a test, type check, lint, or build settles it: run that instead.`

const reviewLine = (review) => `- Then have ${call(review)} check the result. Where a test, type check, lint, or build settles the question, run that first and skip this: a verifier stage over 20 migration trials found nothing the check had not already named and took 74.8% of the arm's cost.`

const STANDING = '- Security-sensitive work stays in this session whatever this says. Opus has been observed refusing delegated security tasks that it accepts inline.'

/** Kept on every note, last, so the transcript scan and a reader can both tell where the instruction came from. */
const SOURCE = '(kelpie delegation triage, prefer mode, route decided with jev)'

/**
 * The note for a decided route.
 *
 * No condition in it. A route only reaches here when its model is below the session's, known or assumed (see
 * decidePrompt), so there is nothing left for the model to compare, and a condition was measured to stop the route
 * being taken. Nothing but the plan either: the security caution that used to close every note is in the orchestration
 * skill and in "keep this here" notes, and the one form measured to work carried only the plan and this source line.
 */
export const renderRoute = (decision) => {
  if (decision.delegate) {
    const lines = [`${capitalised(plan(decision))}.`]
    if (decision.review) lines.push(reviewSentence(decision.review))
    lines.push(SOURCE)
    return lines.join('\n')
  }
  const lines = [`kelpie delegation triage (prefer mode), decided with jev: keep this in this session.`, '']
  lines.push(`${capitalised(decision.reason)}.`)
  lines.push('- Prefer mode delegates when a subagent costs less than this session. This is a prompt where it does not, so do the work here.')
  if (decision.review) lines.push(reviewLine(decision.review))
  lines.push(STANDING)
  return lines.join('\n')
}
