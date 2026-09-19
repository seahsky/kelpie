// What the main session is actually running, which the gate needs before it can keep its own ceiling promise.
//
// Effort is handed over. Measured against claude 2.1.278, the base hook payload carries `effort.level`, one of
// low|medium|high|xhigh|max, documented as the effort "applied to the current turn ... after any silent downgrade for
// the selected model" and "absent ... for models without effort support". The same value reaches the hook's
// environment as CLAUDE_EFFORT.
//
// The model is not handed over. The base payload's fields are session_id, transcript_path, cwd, prompt_id,
// permission_mode, agent_id, agent_type and effort; `model` appears on the SessionStart schema and nowhere a
// PreToolUse hook can see. So the model is read from the transcript the payload points at, where every assistant
// entry records `message.model`. Guessing it instead is not an option: the gate promises never to route a spawn above
// the session's own model, and a wrong guess upward breaks that promise silently.

import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Cheapest first. Unlike MODEL_LADDER this includes fable, because a session can run on it even though the gate cannot route to it. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus', 'fable']

/** Read the tail only. A long session's transcript runs to megabytes, and a gate that stalls changes the run it is measuring. */
export const TRANSCRIPT_TAIL_BYTES = 262144

/** `claude-opus-5`, `opus[1m]`, and `claude-sonnet-5-20260514` each name exactly one tier. Anything else names none. */
export const tierOf = (modelId) => {
  if (typeof modelId !== 'string') return null
  const lowered = modelId.toLowerCase()
  return MODEL_TIERS.find((tier) => lowered.includes(tier)) ?? null
}

/**
 * The tier of the last main-thread assistant turn in a slice of transcript.
 *
 * Sidechain entries are skipped because they are subagent turns, and a subagent's model is the thing being decided
 * here rather than the ceiling on it. A line that will not parse is skipped rather than raised: reading a tail
 * truncates the first line by construction, and a half-written last line is normal while a turn is in flight.
 */
export const sessionModelFromTranscript = (tailText) => {
  const lines = tailText.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    let entry = null
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || entry.type !== 'assistant' || entry.isSidechain === true) continue
    const tier = tierOf(entry.message && entry.message.model)
    if (tier !== null) return tier
  }
  return null
}

/** The last TRANSCRIPT_TAIL_BYTES of a file, as text. Returns '' rather than raising, because no gate failure may reach the session. */
export const readTail = (path, maxBytes = TRANSCRIPT_TAIL_BYTES) => {
  let handle = null
  try {
    const size = statSync(path).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    handle = openSync(path, 'r')
    readSync(handle, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle !== null) closeSync(handle)
  }
}

/**
 * The session's model tier and effort, or null for either one that cannot be established.
 *
 * A null model is not a detail: the caller falls back to the shipped pins on it, because with no known ceiling the
 * gate cannot show that a route is downward.
 */
export const resolveSession = ({ transcriptPath, effortLevel, env = {}, readTailImpl = readTail }) => ({
  model: transcriptPath ? sessionModelFromTranscript(readTailImpl(transcriptPath)) : null,
  effort: effortLevel ?? env.CLAUDE_EFFORT ?? null,
})
