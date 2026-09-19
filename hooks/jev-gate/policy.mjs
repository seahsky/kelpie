// The Stage 4 spawn gate's decision policy, with no I/O in it, so every rule below is testable on its own.
//
// A decision names three things for one spawn: which role, which model, and which reasoning effort.
// `null` in any field means "leave the shipped default alone", which is what makes the static arm a known null.

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

/** The stages the gate can reach. A stage is reachable only if the Workflow tool call's args already name its work. */
export const STAGES = {
  AUDIT_FIND: 'audit.find',
  AUDIT_VERIFY: 'audit.verify',
  MIGRATE_APPLY: 'migrate.apply',
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
    default:
      throw new PolicyError(`${stage} is not a Stage 4 gate stage`)
  }
}

/** Boundaries of a 3-level Score. The docs say a Score lands between levels, so a level owns the half-unit either side of it. */
const SCORE_MECHANICAL = 0.5
const SCORE_MODERATE = 1.5
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
