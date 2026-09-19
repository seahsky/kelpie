import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LADDER,
  MODEL_LADDER,
  MODELS_WITHOUT_EFFORT,
  PolicyError,
  ROLE_MECH,
  ROLE_SESSION,
  ROLE_VERIFIER,
  STAGES,
  applyConfidenceFloor,
  availableModels,
  clampDecision,
  clampRung,
  decideFanout,
  decideReview,
  decideVerify,
  modelCeiling,
  staticDecision,
} from '../hooks/jev-gate/policy.mjs'

const OPUS_SESSION = { model: 'opus', effort: 'xhigh' }

/** The three answers every fan-out decision needs, with the two that are not under test held at a settled value. */
const answers = ({ specified = 0.95, difficulty = 0.1, longHorizon = 0.05, confidence = 0.9 }) => ({
  fully_specified: { type: 'noul', noul: specified },
  difficulty: { type: 'score', score: difficulty, confidence },
  long_horizon: { type: 'noul', noul: longHorizon },
})

test('the ladders stop where Stage 4 says they stop', () => {
  assert.deepEqual(MODEL_LADDER, ['haiku', 'sonnet', 'opus'])
  assert.deepEqual(EFFORT_LADDER, ['low', 'medium', 'high', 'xhigh'])
  assert.ok(!MODEL_LADDER.includes('fable'), 'fable costs more per token than opus, so routing up to it is never a saving')
  assert.ok(!EFFORT_LADDER.includes('max'), 'Stage 4 caps effort at xhigh')
})

test('a fable session may route down to opus, which is the rung below it', () => {
  assert.equal(modelCeiling('fable'), 'opus')
  assert.deepEqual(availableModels('fable'), ['haiku', 'sonnet', 'opus'])
  assert.deepEqual(availableModels('opus'), ['haiku', 'sonnet', 'opus'])
  assert.deepEqual(availableModels('sonnet'), ['haiku', 'sonnet'])
  assert.deepEqual(availableModels('haiku'), ['haiku'])
})

test('an unknown session model yields no ceiling and no options at all', () => {
  assert.equal(modelCeiling(null), null)
  assert.equal(modelCeiling('gpt-4'), null)
  assert.deepEqual(availableModels(null), [], 'with no known ceiling the gate cannot show a route is downward')
})

test('a rung above the ceiling is clamped down, never raised', () => {
  assert.equal(clampRung(MODEL_LADDER, 'opus', 'sonnet', 'model'), 'sonnet')
  assert.equal(clampRung(MODEL_LADDER, 'haiku', 'sonnet', 'model'), 'haiku')
  assert.equal(clampRung(EFFORT_LADDER, 'xhigh', 'xhigh', 'effort'), 'xhigh')
  assert.equal(clampRung(EFFORT_LADDER, 'low', 'high', 'effort'), 'low')
  assert.equal(clampRung(MODEL_LADDER, null, 'opus', 'model'), null)
})

test('an unknown rung is an error, not a silent pass-through', () => {
  assert.throws(() => clampRung(MODEL_LADDER, 'max', 'opus', 'model'), PolicyError)
  assert.throws(() => clampRung(EFFORT_LADDER, 'max', 'xhigh', 'effort'), PolicyError)
})

test('the session model is a hard ceiling for a Sonnet session', () => {
  const clamped = clampDecision({ agentType: ROLE_SESSION, model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' })
  assert.equal(clamped.model, 'sonnet')
  assert.equal(clamped.effort, 'high')
})

test('no effort survives on haiku, which takes no effort parameter', () => {
  assert.ok(MODELS_WITHOUT_EFFORT.has('haiku'))
  const named = clampDecision({ agentType: ROLE_MECH, model: 'haiku', effort: 'xhigh' }, { model: 'opus', effort: 'xhigh' })
  assert.equal(named.effort, null, 'an effort pinned alongside haiku is a fiction in the log')
  const inherited = clampDecision({ agentType: ROLE_SESSION, model: null, effort: 'high' }, { model: 'haiku', effort: 'xhigh' })
  assert.equal(inherited.effort, null, 'inheriting a haiku session means inheriting no effort support either')
})

test('the static policy sets nothing, so the shipped pins stand', () => {
  for (const stage of Object.values(STAGES)) {
    const decision = staticDecision(stage)
    assert.equal(decision.model, null, `${stage} must not pin a model`)
    assert.equal(decision.effort, null, `${stage} must not pin an effort`)
    assert.equal(decision.review, null, `${stage} must not add a review spawn`)
    assert.equal(decision.source, 'static')
  }
  assert.equal(staticDecision(STAGES.AUDIT_FIND).agentType, ROLE_SESSION)
  assert.equal(staticDecision(STAGES.AUDIT_VERIFY).agentType, ROLE_VERIFIER)
  assert.equal(staticDecision(STAGES.MIGRATE_APPLY).agentType, ROLE_MECH)
})

test('an open decision goes to the session tier whatever the difficulty says', () => {
  const decision = decideFanout(STAGES.MIGRATE_APPLY, answers({ specified: 0.12, difficulty: 0.0 }), OPUS_SESSION)
  assert.equal(decision.agentType, ROLE_SESSION)
  assert.equal(decision.model, null)
  assert.equal(decision.effort, null)
})

test('difficulty picks the model and the effort together', () => {
  const at = (difficulty, longHorizon = 0.05) =>
    decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty, longHorizon }), OPUS_SESSION)
  assert.deepEqual([at(0.1).model, at(0.1).effort], ['haiku', null])
  assert.deepEqual([at(1.0).model, at(1.0).effort], ['sonnet', 'medium'])
  assert.deepEqual([at(1.9).model, at(1.9).effort], ['sonnet', 'high'])
  assert.equal(at(1.9).agentType, ROLE_SESSION)
  // Each tier is one rung along exactly one axis, and the model moves last.
  assert.deepEqual(
    [0.1, 1.0, 1.9].map((d) => `${at(d).model}/${at(d).effort}`),
    ['haiku/null', 'sonnet/medium', 'sonnet/high'],
  )
})

test('the top rung and the review are both reached only by hard work that is also a long job', () => {
  const hardShort = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 2.0, longHorizon: 0.1 }), OPUS_SESSION)
  const hardLong = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 2.0, longHorizon: 0.9 }), OPUS_SESSION)
  assert.deepEqual([hardShort.model, hardShort.effort, hardShort.review], ['sonnet', 'high', null], 'A4 beat A0 on both axes, so hard alone does not earn opus')
  assert.deepEqual([hardLong.model, hardLong.effort], ['opus', 'xhigh'])
  assert.notEqual(hardLong.review, null)
  // A long job that is not hard stays on its difficulty tier: duration alone is not a reason to think harder per turn.
  const easyLong = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 0.1, longHorizon: 0.9 }), OPUS_SESSION)
  assert.deepEqual([easyLong.model, easyLong.effort], ['haiku', null])
})

test('a fable session sends even its hardest spawns down to opus, never back to fable', () => {
  const fable = { model: modelCeiling('fable'), effort: 'xhigh' }
  const decision = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 2.0, longHorizon: 0.9 }), fable)
  assert.equal(decision.model, 'opus', 'naming the rung is the only way off the session model')
  assert.equal(decision.agentType, ROLE_SESSION)
})

test('an opus or fable session spends most of its hard range on sonnet', () => {
  // The point of the gate under an expensive session: opus is 2.5x sonnet per token, so only the last cell pays it.
  for (const session of [{ model: 'opus', effort: 'xhigh' }, { model: modelCeiling('fable'), effort: 'xhigh' }]) {
    const tiers = [
      decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 0.1 }), session),
      decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 1.0 }), session),
      decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 2.0, longHorizon: 0.1 }), session),
      decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 2.0, longHorizon: 0.9 }), session),
    ]
    assert.deepEqual(tiers.map((t) => `${t.model}/${t.effort}`), ['haiku/null', 'sonnet/medium', 'sonnet/high', 'opus/xhigh'])
    assert.deepEqual(tiers.map((t) => t.review !== null), [false, false, false, true], 'exactly one cell in four is reviewed')
  }
})

test('a sonnet session reaches its own ceiling by effort alone', () => {
  const sonnet = { model: 'sonnet', effort: 'xhigh' }
  const tiers = [
    decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 0.1 }), sonnet),
    decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 1.0 }), sonnet),
    decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 2.0, longHorizon: 0.1 }), sonnet),
    decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 2.0, longHorizon: 0.9 }), sonnet),
  ]
  assert.deepEqual(tiers.map((t) => `${t.model}/${t.effort}`), ['haiku/null', 'sonnet/medium', 'sonnet/high', 'sonnet/xhigh'])
})

test('the audit finder never gets pinned to the mech-executor role', () => {
  const decision = decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 0.1 }), OPUS_SESSION)
  assert.equal(decision.agentType, ROLE_SESSION, 'auditing is not mechanical execution')
  assert.equal(decision.model, 'haiku')
})

test('a missing answer is an error rather than a confident zero', () => {
  assert.throws(() => decideFanout(STAGES.AUDIT_FIND, { fully_specified: { type: 'noul', noul: 0.9 } }, OPUS_SESSION), PolicyError)
  assert.throws(
    () => decideFanout(STAGES.AUDIT_FIND, { fully_specified: { type: 'noul', noul: 0.9 }, difficulty: { type: 'score', score: 1 } }, OPUS_SESSION),
    PolicyError,
    'long_horizon missing must raise, not read as a short task',
  )
  assert.throws(() => decideVerify({}), PolicyError)
})

test('an unknown session model is an error, so no rung is named on a guess', () => {
  assert.throws(() => decideFanout(STAGES.AUDIT_FIND, answers({}), { model: null, effort: 'xhigh' }), PolicyError)
  assert.throws(() => decideFanout(STAGES.AUDIT_FIND, answers({}), undefined), PolicyError)
})

test('the verify stage routes on whether the check needs reading around the line', () => {
  const shallow = decideVerify({ verify_needs_reasoning: { type: 'noul', noul: 0.1 } })
  assert.deepEqual([shallow.model, shallow.effort], ['haiku', null])
  const deep = decideVerify({ verify_needs_reasoning: { type: 'noul', noul: 0.8 } })
  assert.deepEqual([deep.agentType, deep.model, deep.effort], [ROLE_VERIFIER, 'sonnet', 'medium'])
})

test('a low confidence drops the decision back to the shipped default', () => {
  const given = answers({ difficulty: 0.1, confidence: 0.4 })
  const decided = decideFanout(STAGES.MIGRATE_APPLY, given, OPUS_SESSION)
  const floored = applyConfidenceFloor(STAGES.MIGRATE_APPLY, decided, given, 0.6)
  assert.equal(floored.source, 'fallback')
  assert.equal(floored.agentType, ROLE_MECH)
  assert.equal(floored.model, null)
})

test('a Noul-only answer set carries no confidence, so the floor cannot fire on it', () => {
  const given = { verify_needs_reasoning: { type: 'noul', noul: 0.8 } }
  const floored = applyConfidenceFloor(STAGES.AUDIT_VERIFY, decideVerify(given), given, 0.99)
  assert.equal(floored.source, 'jev', 'a Noul has no confidence field, per docs.typesafe.ai/confidence')
})

test('a review needs hard AND long, so it is the rarest decision the policy makes', () => {
  const TOP = { agentType: ROLE_VERIFIER, model: 'opus', effort: 'xhigh' }
  assert.equal(decideReview(0.1, 0.9, OPUS_SESSION), null, 'long but mechanical is settled by the executable check')
  assert.equal(decideReview(1.0, 0.9, OPUS_SESSION), null, 'long but moderate is too')
  assert.equal(decideReview(2.0, 0.1, OPUS_SESSION), null, 'hard but short stands on the check alone')
  assert.deepEqual(decideReview(1.5, 0.5, OPUS_SESSION), TOP, 'both midpoints inclusive')
  assert.deepEqual(decideReview(2.0, 0.9, OPUS_SESSION), TOP)
})

test('the reviewed cell is already at the top rung, so the review adds independence and not capability', () => {
  const decision = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 2.0, longHorizon: 0.9 }), OPUS_SESSION)
  assert.deepEqual([decision.model, decision.effort], ['opus', 'xhigh'])
  assert.deepEqual(decision.review, { agentType: ROLE_VERIFIER, model: 'opus', effort: 'xhigh' })
  // Hard but short runs on sonnet with nothing checking it but the workflow's own check. Deliberate, and unmeasured.
  const short = decideFanout(STAGES.MIGRATE_APPLY, answers({ difficulty: 2.0, longHorizon: 0.05 }), OPUS_SESSION)
  assert.deepEqual([short.model, short.effort, short.review], ['sonnet', 'high', null])
})

test('a fable session reviews at opus, never at fable', () => {
  const fable = { model: modelCeiling('fable'), effort: 'xhigh' }
  assert.deepEqual(decideReview(2.0, 0.9, fable), { agentType: ROLE_VERIFIER, model: 'opus', effort: 'xhigh' })
})

test('a review is clamped like any other rung, and loses its effort on haiku', () => {
  const onSonnet = clampDecision(decideFanout(STAGES.AUDIT_FIND, answers({ difficulty: 2.0, longHorizon: 0.9 }), { model: 'sonnet', effort: 'xhigh' }), { model: 'sonnet', effort: 'xhigh' })
  assert.deepEqual(onSonnet.review, { agentType: ROLE_VERIFIER, model: 'sonnet', effort: 'xhigh' })
  const onHaiku = clampDecision({ agentType: ROLE_SESSION, model: null, effort: null, review: { agentType: ROLE_VERIFIER, model: 'opus', effort: 'xhigh' } }, { model: 'haiku', effort: 'xhigh' })
  assert.deepEqual(onHaiku.review, { agentType: ROLE_VERIFIER, model: 'haiku', effort: null })
})

test('reviewing turns on the work answers alone, so an open decision that is hard and long still gets one', () => {
  const decision = decideFanout(STAGES.MIGRATE_APPLY, answers({ specified: 0.1, difficulty: 2.0, longHorizon: 0.9 }), OPUS_SESSION)
  assert.equal(decision.agentType, ROLE_SESSION, 'an open decision still stays on the main thread')
  assert.equal(decision.model, null, 'and still inherits, because fully_specified is consulted first and alone')
  assert.deepEqual(decision.review, { agentType: ROLE_VERIFIER, model: 'opus', effort: 'xhigh' })
})

test('a low confidence drops the review along with the rest of the decision', () => {
  const given = answers({ difficulty: 2.0, longHorizon: 0.9, confidence: 0.4 })
  const decided = decideFanout(STAGES.MIGRATE_APPLY, given, OPUS_SESSION)
  assert.notEqual(decided.review, null)
  const floored = applyConfidenceFloor(STAGES.MIGRATE_APPLY, decided, given, 0.6)
  assert.equal(floored.review, null, 'falling back means falling all the way back')
})
