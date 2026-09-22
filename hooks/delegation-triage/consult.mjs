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

const routeLine = (decision) => {
  if (decision.agentType === ROLE_RECON) return `- Send the lookup to ${call(decision)}: ${decision.reason}. You want the answer, not the file dumps.`
  if (decision.agentType === ROLE_ANALYST) return `- Send the question to ${call(decision)}: ${decision.reason}. You want the conclusion and the lines behind it, not the file dumps.`
  return `- Spawn ${call(decision)}: ${decision.reason}.`
}

/**
 * The line that hands the price comparison to the model, when the hook could not make it.
 *
 * Only a headless session's first prompt gets it in practice. An interactive session's model is recorded at
 * SessionStart, and after one assistant turn the transcript names it, so decidePrompt compares the rungs itself.
 */
const onlyAboveLine = (model) => `- If this session runs on ${model} or a cheaper model, do the work here instead: a subagent on the same model pays for the hand-off and saves nothing.`

const SPEC = '- Spec it in one shot: exact file paths, exact symbol names, acceptance criteria, and why the work matters. A subagent cannot ask you a question mid-task.'

const ASK = '- Ask one exact question: the files or symbols it concerns, the claims to check if there are any, and what the answer is for. A subagent cannot ask you a question mid-task.'

/** A lookup takes a question as it stands, a question that needs reasoning takes a sharp one, and work takes a spec. */
const briefLine = (agentType) => (agentType === ROLE_RECON ? null : agentType === ROLE_ANALYST ? ASK : SPEC)

const reviewLine = (review) => `- Then have ${call(review)} check the result. Where a test, type check, lint, or build settles the question, run that first and skip this: a verifier stage over 20 migration trials found nothing the check had not already named and took 74.8% of the arm's cost.`

const STANDING = '- Security-sensitive work stays in this session whatever this says. Opus has been observed refusing delegated security tasks that it accepts inline.'

/**
 * The first line, which is the one a model acts on.
 *
 * A route that holds only above some model says so here rather than in a bullet under it. The unconditional
 * "delegate this." once headed a note whose next lines said to keep the work on an Opus session, and an Opus
 * session read the header and delegated at its own price.
 */
const verdict = (decision) => {
  if (!decision.delegate) return 'keep this in this session.'
  return decision.onlyAbove ? `delegate this only if this session runs on a model above ${decision.onlyAbove}.` : 'delegate this.'
}

/**
 * The note for a decided route.
 *
 * It names the route and the answer behind it, rather than restating the policy. That is the point of asking: prefer
 * mode's own note is a list of routes the model then has to choose between, and a list of options on every prompt is
 * how the first run ended with a note delivered thirteen times and referenced zero times.
 */
export const renderRoute = (decision) => {
  const header = `kelpie delegation triage (prefer mode), decided with jev: ${verdict(decision)}`
  const lines = [header, '']
  if (decision.delegate) {
    const condition = decision.onlyAbove ? ` if this session runs on a model above ${decision.onlyAbove}` : ''
    lines.push(`A subagent on ${decision.model} costs less than doing this here${condition}: the work is big enough to outrun the hand-off (substantial ${decision.substantial}), and ${decision.model} is enough for it.`)
    if (decision.onlyAbove) lines.push(onlyAboveLine(decision.onlyAbove))
    if (decision.precondition) lines.push(`- ${decision.precondition}. Then hand over what is left.`)
    lines.push(routeLine(decision))
    const brief = briefLine(decision.agentType)
    if (brief !== null) lines.push(brief)
  } else {
    lines.push(`${decision.reason.charAt(0).toUpperCase()}${decision.reason.slice(1)}.`)
    lines.push('- Prefer mode delegates when a subagent costs less than this session. This is a prompt where it does not, so do the work here.')
  }
  if (decision.review) lines.push(reviewLine(decision.review))
  lines.push(STANDING)
  return lines.join('\n')
}
