// The Stage 4 spawn gate's decision policy, with no I/O in it, so every rule below is testable on its own.
//
// A decision names three things for one spawn: which role, which model, and which reasoning effort.
// `null` in any field means "leave the shipped default alone", which is what makes the static arm a known null.

import { MODEL_TIERS } from './session.mjs'

/** Cheapest first. `fable` is absent on purpose: at $10/Mtok input against opus's $5, routing up to it can never be a saving. */
export const MODEL_LADDER = ['haiku', 'sonnet', 'opus']

/** Cheapest first. `max` is absent on purpose: Stage 4 caps effort at xhigh. */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh']

/**
 * Haiku 4.5 takes no `effort` parameter at all: it is extended-thinking only, driven by `budget_tokens` with a
 * documented minimum of 1,024. Naming an effort alongside it is a no-op that only puts a fiction in the decision log.
 */
export const MODELS_WITHOUT_EFFORT = new Set(['haiku'])

export const ROLE_MECH = 'kelpie:mech-executor'
export const ROLE_VERIFIER = 'kelpie:verifier'
/** The session tier carries no agentType, so the spawn inherits the main session's model and effort. */
export const ROLE_SESSION = null

/**
 * The recon route, and why it is kelpie's own agent rather than the built-in Explore.
 *
 * Explore inherits the session's model, capped at Opus (code.claude.com/docs/en/sub-agents, since v2.1.198), so under
 * an Opus session it is an Opus subagent: a hand-off with no cheaper price behind it. On run 02 the only three spawns
 * in thirty sessions were Explore, and all three billed Opus alone. `kelpie:recon` is pinned to Haiku, and its brief
 * is scoped to lookups, because kelpie's earlier Haiku `scout` was asked to find problems and manufactured 84 leads
 * that a plain Opus prompt never produced.
 */
export const ROLE_RECON = 'kelpie:recon'

/**
 * The read-only route for a question a lookup cannot answer.
 *
 * recon's brief tells it to stop at a judgment call, so read-only work that needs reasoning sent there came back
 * unanswered or went to general-purpose on the session's model. `kelpie:analyst` is pinned to Sonnet at medium
 * effort and answers one question with `path:line` evidence. Medium rather than low because the Sonnet 5 effort docs
 * warn of under-thinking at low on moderately complex tasks, which is this route's work by definition. Nothing
 * measured supports the pin yet; it is a declared choice, like recon's Haiku pin.
 */
export const ROLE_ANALYST = 'kelpie:analyst'

/**
 * The stages the gate can reach.
 *
 * The three workflow stages are reachable only if the Workflow tool call's args already name their work. `prompt` is
 * the fourth and it is not a workflow stage at all: it is one prompt, decided at UserPromptSubmit before any tool has
 * run, which is the only point where the answer can still be "delegate this" rather than "tier this spawn".
 */
export const STAGES = {
  AUDIT_FIND: 'audit.find',
  AUDIT_VERIFY: 'audit.verify',
  MIGRATE_APPLY: 'migrate.apply',
  PROMPT: 'prompt',
}

export class PolicyError extends Error {}

/**
 * The top rung a session of this model may route to.
 *
 * A fable session gets a ceiling of opus, the rung below it. That is the case with the most to win, because every
 * spawn the gate moves off the session model there moves off the most expensive model on offer. It is also why fable
 * is a valid session model but not a valid route: the gate may route down to opus from it, never up to it.
 *
 * `null` means the session model could not be established. The caller falls back to the shipped pins on it, rather
 * than assume a ceiling, because the whole guarantee is that a route is downward and an assumed ceiling cannot show
 * that.
 */
export const modelCeiling = (sessionModel) => {
  if (sessionModel === 'fable') return 'opus'
  return MODEL_LADDER.includes(sessionModel) ? sessionModel : null
}

/**
 * The rungs the gate may choose from for this session, cheapest first.
 *
 * This is the option list, and it is built here rather than sent to Jev. None of the three questions asked is about
 * models, so a model list in the request's `state` would be context no question uses, which is the context-rot
 * failure mode docs.typesafe.ai/model-jaggedness/jev-1.13 lists. Jev is asked only about the work; this list decides
 * what its answer is allowed to reach.
 */
export const availableModels = (sessionModel) => {
  const ceiling = modelCeiling(sessionModel)
  return ceiling === null ? [] : MODEL_LADDER.slice(0, MODEL_LADDER.indexOf(ceiling) + 1)
}

const rungIndex = (ladder, value, field) => {
  const index = ladder.indexOf(value)
  if (index === -1) throw new PolicyError(`${field} '${value}' is not one of ${ladder.join(', ')}`)
  return index
}

/** Never let the gate pick a rung above the ceiling. The model ceiling comes from the main session's model; the effort ceiling is xhigh. */
export const clampRung = (ladder, value, ceiling, field) => {
  if (value === null || value === undefined) return null
  const wanted = rungIndex(ladder, value, field)
  const limit = rungIndex(ladder, ceiling, `${field} ceiling`)
  return ladder[Math.min(wanted, limit)]
}

const clampReview = (review, ceilings) => {
  if (!review) return null
  const model = clampRung(MODEL_LADDER, review.model, ceilings.model, 'review model')
  const effort = clampRung(EFFORT_LADDER, review.effort, ceilings.effort, 'review effort')
  const running = model ?? ceilings.model
  return { ...review, model, effort: MODELS_WITHOUT_EFFORT.has(running) ? null : effort }
}

export const clampDecision = (decision, ceilings) => {
  const model = clampRung(MODEL_LADDER, decision.model, ceilings.model, 'model')
  const effort = clampRung(EFFORT_LADDER, decision.effort, ceilings.effort, 'effort')
  // A null model means the spawn inherits the session's, so the session's tier is what decides effort support.
  const running = model ?? ceilings.model
  return {
    ...decision,
    model,
    effort: MODELS_WITHOUT_EFFORT.has(running) ? null : effort,
    review: clampReview(decision.review, ceilings),
  }
}

/**
 * What the shipped workflows already do, expressed as a decision.
 *
 * Every field is null, because the shipped scripts pass no model and no effort and let each role's own frontmatter
 * decide (mech-executor is sonnet/low, verifier is inherit/medium). Arm B2 runs this policy, so if the gate-aware
 * overlay is behaviour-neutral, B2 must read as no difference against B1. That is the known null inside the run.
 */
export const staticDecision = (stage) => {
  switch (stage) {
    case STAGES.AUDIT_FIND:
      return { agentType: ROLE_SESSION, model: null, effort: null, review: null, source: 'static', reason: 'shipped default: session tier' }
    case STAGES.AUDIT_VERIFY:
      return { agentType: ROLE_VERIFIER, model: null, effort: null, review: null, source: 'static', reason: 'shipped default: verifier role' }
    case STAGES.MIGRATE_APPLY:
      return { agentType: ROLE_MECH, model: null, effort: null, review: null, source: 'static', reason: 'shipped default: mech-executor role' }
    case STAGES.PROMPT:
      // A prompt has no shipped pin to fall back to, so the fallback is naming no route and letting the mode's own
      // note stand. `delegate: null` is that: not "do not delegate", which is a decision, but "nobody decided".
      return { agentType: ROLE_SESSION, delegate: null, model: null, effort: null, review: null, source: 'static', reason: 'no route named, so the mode note stands' }
    default:
      throw new PolicyError(`${stage} is not a Stage 4 gate stage`)
  }
}

/** Boundaries of a 3-level Score. The docs say a Score lands between levels, so a level owns the half-unit either side of it. */
const SCORE_MECHANICAL = 0.5
const SCORE_MODERATE = 1.5
/** The highest level a 3-level Score can name. */
const SCORE_TOP = 2
/** A Noul is absolute, so 0.5 is its own midpoint and needs no tuning. */
const NOUL_MIDPOINT = 0.5

/** The top of the effort ladder. A review gets it because it runs once per item and is the last thing between a wrong change and the repository. */
const EFFORT_TOP = EFFORT_LADDER[EFFORT_LADDER.length - 1]

/**
 * Whether one item's output gets an independent review, and at what tier. `null` means no review at all.
 *
 * One cell only: hard **and** long-horizon. Both conditions are needed, so this is the rarest decision the policy
 * makes, and it is the only one that adds a spawn instead of re-tiering one.
 *
 * What the two conditions together pick out is the case where being wrong is most expensive. Level 2 of `difficulty`
 * reads "applying the change correctly means reasoning about behaviour this file does not state on its face", so no
 * executable check settles it. `long_horizon` then says the work runs past half an hour, so a wrong answer is not one
 * bad edit to redo but a long job to unwind.
 *
 * The executor on this cell already runs at the top rung, so the review does not add capability. Independence is what
 * it adds, and `skills/orchestration/SKILL.md` states the reason: "the fresh-context independence is the whole value
 * — self-certification from the context that wrote the code misses its own blind spots by construction." It runs at
 * the top rung and the top of the effort ladder to match the work it is checking, and because SKILL.md pins
 * `kelpie:verifier` to `inherit` on the grounds that adversarial checking is where you want full capability rather
 * than a cheaper tier.
 *
 * Every other cell gets no review, including hard-but-short, whose executor is sonnet. That leaves it checked only by
 * whatever executable check the workflow runs. It is a deliberate trade and the measurement behind it is kelpie's
 * own: on the Stage 2 run a per-file verifier stage ran on top of the project's test command across 20 migration
 * trials, found nothing the check had not already named, and took 74.8% of the arm's cost. That was measured on
 * mechanical work, so it does not settle the hard-but-short case either way; nothing measured does.
 */
export const decideReview = (difficulty, longHorizon, ceilings) =>
  difficulty < SCORE_MODERATE || longHorizon < NOUL_MIDPOINT
    ? null
    : { agentType: ROLE_VERIFIER, model: ceilings.model, effort: EFFORT_TOP }

/**
 * Turn one item's answers into a decision for a fan-out stage.
 *
 * `fully_specified` is consulted first and alone, because skills/orchestration/SKILL.md states it as a gate and not a
 * preference: work with an open decision in it stays at the session tier whatever the difficulty says.
 *
 * Difficulty then picks a model, and effort follows from difficulty rather than being pinned once:
 *
 *   mechanical -> haiku, no effort         the tier kelpie already measured on 896 mech-executor spawns
 *   moderate   -> sonnet, medium           low is the one cell nothing supports; see the note below
 *   hard       -> sonnet, high             the best cell Stage 3 measured; see the note below
 *   hard, long -> the top rung, xhigh      the one case inside xhigh's documented envelope
 *
 * The last tier alone also carries a `review`: one extra verifier spawn at the same top rung and xhigh. See
 * decideReview. Hard-but-short is not reviewed, so sonnet's work there stands on the workflow's executable check.
 *
 * Effort moves before the model does, which is the order the effort docs recommend ("Tuning effort is often a better
 * lever than switching models") and the order the price table rewards: opus is 2.5x sonnet per token on both input and
 * output, while a step up the effort ladder buys thinking tokens at the tier already in use. So each tier above is one
 * rung along exactly one axis, and the model only steps up on the last one.
 *
 * Hard work goes to sonnet, not to the session's model. Stage 3 is the only thing measured on this, and it says A4
 * (Sonnet 5 at high effort) beat A0 (Opus 5 at high effort) on both axes at once: 83.3% against 80.0% solved, $0.84
 * against $1.97 per solved task, with 3 timeouts against 8 and no model fallbacks against 6. Routing every hard item
 * to the session's own model would spend 2.5x per token to leave the best cell on the table. Both arms are main
 * sessions rather than spawns, so this is the strongest evidence available and not proof.
 *
 * The top rung is reserved for hard work that is also long. That is the cell where a capability ceiling actually
 * bites, because the cost of being wrong compounds over the whole job rather than over one edit, and it is furthest
 * from what Stage 3 measured. It is also the only cell that ever routes a spawn up from sonnet.
 *
 * `medium` and not `low` on the moderate tier. The effort docs state that Sonnet 5 "respects effort levels strictly"
 * and that "on moderately complex tasks running at `low` effort there is some risk of under-thinking", which is this
 * tier by name. Nothing measured favours `low` over the default for a Sonnet subagent, so the pin that had the
 * documented risk attached to it is the one that moves. `medium` is a declared choice, not a measured optimum: it
 * keeps cost ordered with difficulty, which is the property the gate exists to test.
 *
 * `xhigh` only on the long-horizon branch. The effort docs scope xhigh to "long-horizon work (30+ min tasks)" and
 * demanding agentic coding, and warn that stepping past it "adds significant cost for relatively small quality
 * gains" unless evals show headroom. A per-file spawn is usually far shorter than that, so the gate asks whether this
 * one is rather than assuming either way.
 */
export const decideFanout = (stage, answers, ceilings) => {
  const specified = answers.fully_specified?.noul
  const difficulty = answers.difficulty?.score
  const longHorizon = answers.long_horizon?.noul
  if (typeof specified !== 'number' || typeof difficulty !== 'number' || typeof longHorizon !== 'number') {
    throw new PolicyError(`${stage}: answers must carry a numeric fully_specified.noul, difficulty.score, and long_horizon.noul`)
  }
  if (!ceilings || modelCeiling(ceilings.model) === null) {
    throw new PolicyError(`${stage}: the session model must be known before a rung can be named`)
  }
  // Reviewing turns on the two work answers alone, so an item that is hard, long, and has an open decision in it is
  // still reviewed even though it stays at the session tier.
  const review = decideReview(difficulty, longHorizon, ceilings)
  if (specified < NOUL_MIDPOINT) {
    return { agentType: ROLE_SESSION, model: null, effort: null, review, source: 'jev', reason: `open decision (fully_specified ${specified})` }
  }
  const role = stage === STAGES.MIGRATE_APPLY ? ROLE_MECH : ROLE_SESSION
  if (difficulty < SCORE_MECHANICAL) {
    return { agentType: role, model: 'haiku', effort: null, review, source: 'jev', reason: `mechanical (difficulty ${difficulty}); haiku takes no effort parameter` }
  }
  if (difficulty < SCORE_MODERATE) {
    return { agentType: role, model: 'sonnet', effort: 'medium', review, source: 'jev', reason: `moderate (difficulty ${difficulty})` }
  }
  if (longHorizon < NOUL_MIDPOINT) {
    return { agentType: ROLE_SESSION, model: 'sonnet', effort: 'high', review, source: 'jev', reason: `hard (difficulty ${difficulty}, long_horizon ${longHorizon})` }
  }
  // The top reachable rung is named rather than inherited, which is the only way a fable session's hardest spawns land
  // on opus rather than back on fable. Under a sonnet session this is sonnet, so the branch changes effort alone.
  return { agentType: ROLE_SESSION, model: ceilings.model, effort: 'xhigh', review, source: 'jev', reason: `hard and long-horizon (difficulty ${difficulty}, long_horizon ${longHorizon})` }
}

/**
 * Turn the one stage-level answer into a decision for every verifier spawn in this workflow.
 *
 * No long-horizon branch here. A verifier judges one finding against one file, so the stage is short by construction,
 * which is the case xhigh is not for.
 */
export const decideVerify = (answers) => {
  const needsReasoning = answers.verify_needs_reasoning?.noul
  if (typeof needsReasoning !== 'number') {
    throw new PolicyError('audit.verify: answers must carry a numeric verify_needs_reasoning.noul')
  }
  return needsReasoning < NOUL_MIDPOINT
    ? { agentType: ROLE_VERIFIER, model: 'haiku', effort: null, source: 'jev', reason: `pattern-visible (verify_needs_reasoning ${needsReasoning}); haiku takes no effort parameter` }
    : { agentType: ROLE_VERIFIER, model: 'sonnet', effort: 'medium', source: 'jev', reason: `needs reading (verify_needs_reasoning ${needsReasoning})` }
}

/**
 * Which prompt answers decide whether there is a route, and which only decide how it is tiered.
 *
 * The split exists because a flat floor once threw away a verdict it had no business judging: the answer that
 * settled the route carried no confidence at all, and the difficulty answer came back at 0.52 against a floor of
 * 0.6, so the lowest confidence across all five discarded the whole decision. A Noul carries no confidence field, so
 * in practice the decisive list never trips the floor today. It is listed anyway, because the rule is about which
 * answer is load-bearing rather than about which type happens to report a confidence.
 */
export const PROMPT_DECISIVE = ['substantial', 'read_only', 'fully_specified']
export const PROMPT_TIERING = ['difficulty', 'long_horizon']

const lowestConfidence = (answers, ids) => {
  const seen = ids
    .map((id) => answers[id])
    .map((answer) => (answer && typeof answer.confidence === 'number' ? answer.confidence : null))
    .filter((value) => value !== null)
  return seen.length > 0 ? Math.min(...seen) : null
}

/** The rung a prompt's work needs, cheapest first: 0 is haiku, 1 is sonnet, 2 is the top rung the session allows. */
const promptRung = (difficulty, longHorizon) => {
  if (difficulty < SCORE_MECHANICAL) return 0
  if (difficulty < SCORE_MODERATE) return 1
  return longHorizon < NOUL_MIDPOINT ? 1 : 2
}

const rungReason = (difficulty, longHorizon) => {
  if (difficulty < SCORE_MECHANICAL) return `mechanical (difficulty ${difficulty})`
  if (difficulty < SCORE_MODERATE) return `moderate (difficulty ${difficulty})`
  return longHorizon < NOUL_MIDPOINT
    ? `hard (difficulty ${difficulty}, long_horizon ${longHorizon})`
    : `hard and long-horizon (difficulty ${difficulty}, long_horizon ${longHorizon})`
}

/**
 * Turn one prompt's answers into a route, for the delegation triage in prefer mode.
 *
 * The rule is the one prefer mode exists for: hand the work to a subagent when that costs less than doing it here,
 * and only then. Two conditions have to hold together. The work has to be big enough that a saving on every step
 * outruns the fixed cost of the hand-off, which is `substantial`. And the subagent has to run on a cheaper model than
 * this session, because a subagent on the same model pays the hand-off and saves nothing on price. The second
 * condition is arithmetic rather than judgment, so it is computed here and never asked.
 *
 * The rung is the cheapest model the work can stand, from the same difficulty ladder the fan-out stages use:
 *
 *   mechanical             -> haiku
 *   moderate               -> sonnet
 *   hard                   -> sonnet     Stage 3: Sonnet 5 beat Opus 5 on pass rate and on cost per solved task
 *   hard and long-horizon  -> the top rung this session allows
 *
 * A rung at or above the session's own model stays here. Anything below it is delegated, with the rung as the call's
 * `model`: a read-only lookup (mechanical) to kelpie:recon, a read-only question that needs reasoning to
 * kelpie:analyst, and everything else to kelpie:mech-executor.
 *
 * Work with an open decision in it is delegated after the decision, not with it. The decision is made here, and what
 * is handed over afterwards is fully specified, which is the only kind of work the Sonnet pin on mech-executor is
 * measured on. skills/orchestration/SKILL.md says the same tier "fails expensively rather than cheaply" on
 * open-ended work, so the precondition is part of the route rather than advice beside it. The analyst gets the same
 * precondition in its own words: a vague question comes back as a survey, and a survey is the finder failure. A recon
 * lookup gets none, because a lookup has no decision in it.
 *
 * No effort is named. The Agent tool takes a per-call `model` and has no effort parameter, so an effort in a
 * prompt-level route would be something the model cannot pass, and the role's own frontmatter effort applies either
 * way. The fan-out stages keep theirs, because a workflow's agent() call does take one.
 *
 * An unknown session model hands the comparison to the model rather than dropping it. On the first prompt of a
 * session the transcript holds no assistant turn yet. An interactive startup or compact payload carries the model
 * and hooks/session-model records it, but a resume, a /clear, and every `claude -p` SessionStart send none, and no
 * UserPromptSubmit payload has it (checked on 2.1.278 and 2.1.280). The first prompt is often the only one, and on run 02 the model was unknown on every consult,
 * so every route inherited the session's model and no route could be cheaper. So the route is named with
 * `onlyAbove`, and the note makes its first line conditional on the model running above that rung. The model knows
 * what it runs on.
 *
 * The confidence floor, per answer. An unsure answer that decides whether there is a route means no route, and the
 * mode's own note stands. An unsure difficulty is read one level harder rather than dropped, and the review it alone
 * decided is dropped. Harder is the direction in which a wrong guess costs money rather than a failed job. It is a
 * level and not a model rung because the ladder maps two levels to Sonnet: moderate and hard-but-short. On run 02
 * every difficulty answer came back between 1.66 and 1.70 at confidence 0.50 to 0.55, against the floor of 0.6. A
 * model rung up would have sent all ten back to Opus over a doubt that could not change the answer from Sonnet.
 *
 * The review gate runs on every route, this session's own work included: a hard, long job checked only by whoever
 * did it is the self-certification blind spot SKILL.md names, whether or not anything was spawned.
 */
export const decidePrompt = (answers, { session = null, floor = null } = {}) => {
  const substantial = answers.substantial?.noul
  const readOnly = answers.read_only?.noul
  const specified = answers.fully_specified?.noul
  const difficulty = answers.difficulty?.score
  const longHorizon = answers.long_horizon?.noul
  for (const [id, value] of [['substantial.noul', substantial], ['read_only.noul', readOnly], ['fully_specified.noul', specified], ['difficulty.score', difficulty], ['long_horizon.noul', longHorizon]]) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new PolicyError(`${STAGES.PROMPT}: answers must carry a numeric ${id}`)
    }
  }
  const decisive = floor === null ? null : lowestConfidence(answers, PROMPT_DECISIVE)
  if (decisive !== null && decisive < floor) {
    return { ...staticDecision(STAGES.PROMPT), source: 'fallback', reason: `confidence ${decisive} below floor ${floor} on an answer that decided the route` }
  }
  const tiering = floor === null ? null : lowestConfidence(answers, PROMPT_TIERING)
  const unsure = tiering !== null && tiering < floor
  const ceiling = modelCeiling(session)
  const review = unsure ? null : decideReview(difficulty, longHorizon, { model: ceiling })
  const base = { substantial, review: review === null ? null : { ...review, effort: null }, source: 'jev' }
  const stay = (reason) => ({ ...base, delegate: false, agentType: ROLE_SESSION, model: null, effort: null, reason })
  if (substantial < NOUL_MIDPOINT) return stay(`the work is smaller than handing it over (substantial ${substantial})`)

  const rung = promptRung(unsure ? Math.min(difficulty + 1, SCORE_TOP) : difficulty, longHorizon)
  const model = rung === 2 ? (ceiling ?? MODEL_LADDER[MODEL_LADDER.length - 1]) : MODEL_LADDER[rung]
  const why = unsure
    ? `${rungReason(difficulty, longHorizon)}, read one level harder because difficulty came back at confidence ${tiering}, under the floor of ${floor}`
    : rungReason(difficulty, longHorizon)
  const sessionRank = MODEL_TIERS.indexOf(session)
  if (sessionRank !== -1 && MODEL_TIERS.indexOf(model) >= sessionRank) {
    return stay(`the cheapest model that fits is ${model}, for work that is ${why}; this session already runs on ${session}, so a subagent adds the hand-off and saves nothing`)
  }
  const agentType = readOnly < NOUL_MIDPOINT ? ROLE_MECH : rung === 0 ? ROLE_RECON : ROLE_ANALYST
  const open = specified < NOUL_MIDPOINT
  const precondition = !open || agentType === ROLE_RECON
    ? null
    : agentType === ROLE_ANALYST
      ? `Pin down the exact question here first (fully_specified ${specified})`
      : `Resolve every open decision here first (fully_specified ${specified})`
  return {
    ...base,
    delegate: true,
    agentType,
    model,
    effort: null,
    ...(precondition === null ? {} : { precondition }),
    ...(sessionRank === -1 ? { onlyAbove: model } : {}),
    reason: why,
  }
}

/**
 * Drop back to the shipped default when Jev is not sure enough to be worth acting on.
 *
 * The floor is a declared prior, not a measured threshold: a wrong route here costs at most one re-run, so the band is
 * set once before the run and never tuned. Every confidence seen is recorded, so a later stage can set it from data.
 * A Noul carries no confidence field at all, which is why only Score answers are checked.
 */
export const applyConfidenceFloor = (stage, decision, answers, floor) => {
  const confidences = Object.values(answers)
    .map((answer) => (answer && typeof answer.confidence === 'number' ? answer.confidence : null))
    .filter((value) => value !== null)
  const lowest = confidences.length > 0 ? Math.min(...confidences) : null
  if (lowest !== null && lowest < floor) {
    return { ...staticDecision(stage), source: 'fallback', reason: `confidence ${lowest} below floor ${floor}` }
  }
  return decision
}
