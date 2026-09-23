#!/usr/bin/env node
// kelpie's delegation triage: a UserPromptSubmit hook that makes the delegation decision happen on every prompt
// rather than only when the model happens to think of it.
//
// Why it exists. Over 180 trials in kelpie's Stage 2 run, Opus 5 spawned a subagent zero times, with the plugin
// installed and without. The mechanism was there and the model never reached for it. This hook puts the decision in
// front of the model on the prompts where it could go either way.
//
// Why it is on by default, in prefer mode. prefer mode hands work to a subagent only when that subagent runs on a
// cheaper model than the session and the work is big enough to outrun the hand-off, so on most prompts it still says
// "do it here", or nothing. What it adds is the case the model never reaches for on its own: a job an Opus session
// would do itself that Sonnet or Haiku can do for less. See DEFAULT_MODE in config.mjs.
//
// Why prefer mode is different from the rest. The other modes decide from keyword signals and argue for the main
// thread, which is the right cost for confirming a default that was correct on 180 of 180 measured prompts. prefer
// mode asks a different question, whether a cheaper model can do this job, and a keyword score cannot answer it.
// With a Jev API key and the jev_send_prompts option on, prefer mode asks about the prompt instead and injects the route it gets back,
// naming the agent, the model, and whether the result needs an independent review. See consult.mjs, which also
// states what that costs: the text of every prompt it reads goes to a third party before the turn starts.
//
// It never rewrites the prompt and never blocks a turn. Every failure path emits nothing, which leaves the prompt
// exactly as the user typed it.
//
// Every decision it makes is logged when a log path is configured, including the decisions to say nothing. That is
// not symmetry for its own sake: kelpie's paired A/B ran ten tickets in prefer mode, the note fired on none of them,
// and nothing recorded it, so the arm measured the plugin's presence while reading as a measurement of the triage.

import { resolveConsult, resolveMode, resolveThreshold } from './config.mjs'
import { fingerprint, logger, resolveLogPath, resolveVerbosity } from '../log.mjs'
import { renderNote, thresholdFor, triage } from './signals.mjs'
import { consult, renderRoute } from './consult.mjs'
import { recordedModelPath, resolveSession } from '../jev-gate/session.mjs'
import { flag, str } from '../env.mjs'

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The note to inject, and why.
 *
 * It returns the reasoning rather than just the note so the log can carry the reason a prompt got nothing. "Silent"
 * has four different causes here and they are not interchangeable: the triage being off is a configuration state,
 * a quiet prompt is one the hook has no business reading, and a prompt under the bar is the triage working.
 */
export const decide = ({ mode, prompt, threshold = null }) => {
  if (mode === 'off') return { note: null, quiet: false, reason: 'triage is off', score: null, fired: null, bar: null }
  const result = triage(prompt)
  // always is the mode whose bar is zero, so it speaks with nothing fired. An explicit threshold beats both.
  const bar = threshold ?? (mode === 'always' ? 0 : thresholdFor(mode))
  if (result.quiet) return { note: null, quiet: true, reason: 'prompt is empty, a slash command, or a notice Claude Code generated', score: result.score, fired: result.fired, bar }
  if (result.score < bar) return { note: null, quiet: false, reason: `score ${result.score} is under the bar of ${bar}`, score: result.score, fired: result.fired, bar }
  return { note: renderNote({ ...result, mode }), quiet: false, reason: `score ${result.score} clears the bar of ${bar}`, score: result.score, fired: result.fired, bar }
}

const main = async () => {
  const event = JSON.parse(await readStdin())
  // Registered on UserPromptSubmit only, but a hook that reads a payload it does not understand should say nothing
  // rather than act on guesses about its shape.
  if (event.hook_event_name !== 'UserPromptSubmit') return null
  const cwd = event.cwd ?? ''
  const env = process.env
  const { mode, source } = resolveMode({ env, cwd })
  const threshold = resolveThreshold({ env })
  const verdict = decide({ mode, prompt: event.prompt, threshold })
  const verbosity = resolveVerbosity({ env })

  const log = logger({
    path: resolveLogPath({ env, cwd }).path,
    base: { hook: 'delegation-triage', session_id: event.session_id ?? null, cwd: cwd || null },
  })

  // prefer mode with a key asks Jev about the prompt, and the answer replaces the keyword bar rather than adding to
  // it: a prompt that scores zero can still be a job that is cheaper split up, and a prompt that scores three can
  // still be cheaper done here. The score is still computed above and still logged, because the other modes run on
  // it and the two disagreeing is worth being able to read.
  // Trimmed, and by the same helper the request builder uses. A key of spaces passed a raw presence check while
  // settings() trimmed it to nothing, so the consult ran and sent the prompt with an empty bearer token: a
  // misconfiguration that should read as "no key" instead put the prompt on the wire.
  const consulting = resolveConsult({
    env,
    mode,
    hasKey: str(env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY, '') !== '',
    allowed: flag(env.CLAUDE_PLUGIN_OPTION_JEV_SEND_PROMPTS),
  })
  const session = consulting.on && !verdict.quiet
    ? resolveSession({
      transcriptPath: event.transcript_path,
      effortLevel: event.effort?.level,
      recordedPath: recordedModelPath({ dataDir: env.CLAUDE_PLUGIN_DATA, sessionId: event.session_id }),
      env,
    })
    : { model: null, modelSource: null, effort: null }
  const route = consulting.on && !verdict.quiet
    ? await consult({ prompt: event.prompt, sessionModel: session.model, env, record: log, verbosity })
    : null
  // No route means no answer from Jev, so prefer mode's own note stands. That is what prefer mode said before the
  // consult existed, and a third party being down is not a reason to stop answering.
  const note = route === null ? verdict.note : renderRoute(route)

  const prompt = typeof event.prompt === 'string' ? event.prompt : ''
  log({
    event: 'decision',
    mode,
    mode_source: source,
    // null means the mode's own bar applied, which is not the same fact as a bar that was set to that number.
    threshold_override: threshold,
    bar: verdict.bar,
    score: verdict.score,
    fired: verdict.fired,
    consulted: consulting.on,
    consult_reason: consulting.reason,
    session_model: session.model,
    session_model_source: session.modelSource,
    decided_by: route === null ? 'signals' : 'jev',
    route: route === null ? null : { delegate: route.delegate, agentType: route.agentType, model: route.model, only_above: route.onlyAbove ?? null, review: route.review },
    emitted: note !== null,
    reason: route === null ? verdict.reason : route.reason,
    prompt_chars: prompt.length,
    prompt_sha256: fingerprint(prompt),
    // The text itself only when it has been asked for by name: a prompt carries whatever the user typed into it.
    ...(verbosity.prompts ? { prompt } : {}),
    ...(note === null ? {} : { note_chars: note.length }),
  })

  if (note === null) return null
  // additionalContext only. updatedInput would rewrite what the user typed, and no triage is worth that.
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }
}

main()
  .then((output) => {
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`)
    process.exit(0)
  })
  .catch((error) => {
    // Emitting nothing leaves the prompt exactly as it was. A triage that breaks a turn is worse than no triage.
    // The failure is still recorded where the environment alone says where, since a payload that would not parse
    // carries no cwd to look a project config up with.
    logger({ path: resolveLogPath({ env: process.env }).path, base: { hook: 'delegation-triage' } })({
      event: 'error',
      message: String(error && error.message ? error.message : error).slice(0, 500),
    })
    process.exit(0)
  })
