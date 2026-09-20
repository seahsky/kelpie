// kelpie's decision log: one JSON line per decision, from both hooks, to one file.
//
// Why it exists. kelpie's own paired A/B ran ten tickets with the triage in prefer mode and reported a 22% cost
// saving. The triage had fired on none of them. Nothing in the run recorded that, so it took a transcript forensics
// pass afterwards to find out that the arm had measured the plugin's presence and not the triage at all. A hook
// whose decisions are invisible is a hook nobody can check, and "it was on" is not the same claim as "it spoke".
//
// So every decision is logged, including the decisions to stay silent. A log that only records the times a hook
// acted answers the easy question and hides the interesting one.
//
// What it will not do. It never throws, never blocks, and never fails a turn: a hook that breaks because it could
// not write its own log is worse than a hook with no log. It is off until a path is configured, because a plugin
// that writes files nobody asked for is a plugin that writes files nobody asked for.
//
// What it holds back by default. Prompts and file excerpts can carry anything the user typed or the repo contains,
// so neither is written unless it is asked for by name. What is always written is the shape of them: how long, and
// a hash that tells two prompts apart without disclosing either.

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { logInFile, projectConfigPath, userConfigPath } from './delegation-triage/config.mjs'

/** A prompt or an excerpt is identified by its hash, so a log can be read and compared without carrying the text. */
export const fingerprint = (text) => (typeof text === 'string' ? createHash('sha256').update(text).digest('hex').slice(0, 16) : null)

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim())

/**
 * Where the log goes, most specific source first: the environment, then this project, then the user.
 *
 * `override` is the hook's own variable where it has one. The gate shipped with `KELPIE_GATE_LOG` before this module
 * existed and configurations use it, so it keeps working and keeps beating the shared variable.
 */
export const resolveLogPath = ({ env = {}, cwd = '', override = '', logInFileImpl = logInFile } = {}) => {
  const fromOverride = String(override ?? '').trim()
  if (fromOverride) return { path: fromOverride, source: 'env' }
  const fromEnv = String(env.KELPIE_LOG ?? '').trim()
  if (fromEnv) return { path: fromEnv, source: 'env' }
  if (cwd) {
    const project = logInFileImpl(projectConfigPath(cwd))
    if (project !== null) return { path: project, source: projectConfigPath(cwd) }
  }
  const userPath = userConfigPath({ env })
  const user = logInFileImpl(userPath)
  if (user !== null) return { path: user, source: userPath }
  return { path: null, source: 'default' }
}

/** Whether the log may carry the prompt text and the file excerpts that were uploaded. Off unless asked for by name. */
export const resolveVerbosity = ({ env = {} } = {}) => ({
  prompts: truthy(env.KELPIE_LOG_PROMPTS),
  excerpts: truthy(env.KELPIE_LOG_EXCERPTS),
})

/**
 * A writer bound to one path, or a no-op when nothing is configured.
 *
 * `appendFileSync` on one line is one write, which is what keeps concurrent sessions from interleaving halves of
 * each other's entries. Every failure is swallowed: the log is the thing that can be lost here.
 */
export const logger = ({ path, base = {}, appendImpl = appendFileSync } = {}) => {
  if (!path) return () => {}
  return (entry) => {
    try {
      appendImpl(path, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...base, ...entry })}\n`)
    } catch {
      // Losing the log is the lesser harm. A hook that fails a turn over its own bookkeeping is the greater one.
    }
  }
}
