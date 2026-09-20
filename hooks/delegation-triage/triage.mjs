#!/usr/bin/env node
// kelpie's delegation triage: a UserPromptSubmit hook that makes the delegation decision happen on every prompt
// rather than only when the model happens to think of it.
//
// Why it exists. Over 180 trials in kelpie's Stage 2 run, Opus 5 spawned a subagent zero times, with the plugin
// installed and without. The mechanism was there and the model never reached for it. This hook puts the decision in
// front of the model on the prompts where it could go either way. It is a triage, not a push: the policy it injects
// says the main thread wins unless the work does not fit one context, which is what the same benchmark measured.
// The one exception is prefer mode, which a user opts into deliberately and which inverts that default.
//
// Why it is off until you turn it on. A note on every prompt is context on every prompt, and on 180 of 180 measured
// prompts the right answer was "do not delegate". Shipping it on would charge every install for a decision that is
// already correct most of the time. `/kelpie:delegation-triage` writes the config file that turns it on.
//
// Why prefer mode is different from the rest. The other modes decide from keyword signals, which is the right cost
// for confirming a default that was correct on 180 of 180 measured prompts. prefer mode has opted out of that
// default, so a keyword score is no longer enough: it cannot tell a job that splits from a job that does not. With a
// Jev API key configured, prefer mode asks about the prompt instead and injects the route it gets back, naming the
// agent, the model, the effort, and whether the result needs an independent review. See consult.mjs, which also
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
import { resolveSession } from '../jev-gate/session.mjs'

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
  const consulting = resolveConsult({ env, mode, hasKey: (env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY ?? '') !== '' })
  const session = consulting.on && !verdict.quiet
    ? resolveSession({ transcriptPath: event.transcript_path, effortLevel: event.effort?.level, env })
    : { model: null, effort: null }
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
    decided_by: route === null ? 'signals' : 'jev',
    route: route === null ? null : { delegate: route.delegate, agentType: route.agentType, model: route.model, effort: route.effort, review: route.review },
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
