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
//
// The transcript cannot answer on the first prompt, because it has no assistant turn yet. Measured on 2.1.280,
// interactive and under `claude -p`: on a fresh session the file does not even exist when UserPromptSubmit runs.
// The first prompt is often the only one, so the SessionStart hook in hooks/session-model records the model an
// interactive startup or compact payload carries, and resolveSession falls back to that record. The transcript still
// wins once it has an assistant turn, because it reflects a /model switch and the record does not. `claude -p`, a
// resume, and a /clear send no model on SessionStart, so no record backs them; see recordFor. A prompt there
// resolves to null only while the transcript has no main-thread assistant turn, which a resume usually has.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

/** A session id is a file name below, so anything that could step out of the directory names no file. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Where the SessionStart record for one session lives, or null where it cannot live.
 *
 * `dataDir` is CLAUDE_PLUGIN_DATA, the directory Claude Code keeps for a plugin across updates. It is unset outside a
 * plugin hook, such as under the test runner, and then there is no record to read or write.
 */
export const recordedModelPath = ({ dataDir, sessionId }) =>
  typeof dataDir === 'string' && dataDir !== '' && typeof sessionId === 'string' && SESSION_ID.test(sessionId)
    ? join(dataDir, 'sessions', `${sessionId}.json`)
    : null

/**
 * How long a record outlives its session. Only housekeeping: the age of a record never makes it wrong, and the
 * record is read only before a session's first reply. See recordFor for what does make one wrong.
 */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What one SessionStart event does to the record: write it, forget it, or nothing, with the reason.
 *
 * Measured on 2.1.280, interactive: `startup` and `compact` payloads name the model, and `clear` and `resume` send
 * `model: null`. A resume keeps the session id and can change the model (`--resume <id> --model sonnet`), so a record
 * from before it may name a model the session no longer runs. Such an event forgets the record, and the triage treats
 * the model as unknown until the transcript names it. `clear` starts a new session id whose payload names no
 * previous one, so that session has no record to read.
 */
export const recordFor = ({ event, dataDir, now }) => {
  const nothing = (reason) => ({ record: null, forget: null, reason })
  if (event.hook_event_name !== 'SessionStart') return nothing('not a SessionStart event')
  const path = recordedModelPath({ dataDir, sessionId: event.session_id })
  if (path === null) return nothing('no plugin data directory or no usable session id')
  if (tierOf(event.model) === null) {
    return { record: null, forget: path, reason: `payload model ${JSON.stringify(event.model ?? null)} names no tier, so any earlier record may be stale` }
  }
  return { record: { path, body: { model: event.model, source: event.source ?? null, recorded_at: new Date(now).toISOString() } }, forget: null, reason: 'recorded' }
}

/**
 * The tier the SessionStart hook recorded, or null where it recorded none.
 *
 * A missing file is the normal case for a headless session, so it is null. Any other failure is raised: the record is
 * written by rename, so a file that will not read or parse is a fault worth the caller's log, not a quiet unknown.
 */
export const readRecordedModel = (path, readImpl = readFileSync) => {
  let text = null
  try {
    text = readImpl(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  return tierOf(JSON.parse(text).model)
}

/**
 * The session's model tier and effort, or null for either one that cannot be established.
 *
 * `modelSource` says which of the two sources answered, so a log can tell a first-prompt answer from a later one.
 *
 * A null model is not a detail: the caller falls back to the shipped pins on it, because with no known ceiling the
 * gate cannot show that a route is downward.
 */
export const resolveSession = ({ transcriptPath, effortLevel, recordedPath = null, env = {}, readTailImpl = readTail, readRecordedImpl = readRecordedModel }) => {
  const effort = effortLevel ?? env.CLAUDE_EFFORT ?? null
  const fromTranscript = transcriptPath ? sessionModelFromTranscript(readTailImpl(transcriptPath)) : null
  if (fromTranscript !== null) return { model: fromTranscript, modelSource: 'transcript', effort }
  const fromRecord = recordedPath ? readRecordedImpl(recordedPath) : null
  return { model: fromRecord, modelSource: fromRecord === null ? null : 'session_start', effort }
}
