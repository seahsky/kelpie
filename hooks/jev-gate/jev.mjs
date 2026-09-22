// A minimal TypeSafe System One client for the Stage 4 gate.
//
// The contract is taken from docs.typesafe.ai/api.md, read 2026-09-18:
// POST https://api.typesafe.ai/v1/systemone with bearer auth and three fields (state, model, questions), answering
// each question independently against the same state. 401/422 are terminal; 429/529 get exponential backoff.
//
// Question wording follows docs.typesafe.ai/model-jaggedness/jev-1.13 (reviewed 2026-09-17): every number is computed
// here and passed in state rather than asked for, each question asks one literal thing, and state carries only what
// that question needs.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

/** Keep state well inside the documented 32k budget for state plus the longest question, and keep context rot down. */
export const EXCERPT_MAX_LINES = 120
export const EXCERPT_MAX_CHARS = 6000

/** Terminal per the API reference; retrying them only burns wall clock. */
const TERMINAL_STATUSES = new Set([400, 401, 403, 422])

export class JevError extends Error {
  constructor(message, { terminal = false } = {}) {
    super(message)
    this.name = 'JevError'
    this.terminal = terminal
  }
}

export const excerpt = (text) => {
  const lines = text.split('\n').slice(0, EXCERPT_MAX_LINES).join('\n')
  return lines.length > EXCERPT_MAX_CHARS ? `${lines.slice(0, EXCERPT_MAX_CHARS)}\n...[truncated]` : lines
}

const FULLY_SPECIFIED = {
  type: 'noul',
  instructions: '`work` states exactly what to do to the file in `file_excerpt`. Whoever does it has no design, naming, or approach decision left to make.',
  criteria: {
    true: 'The work names the exact change to make, and the file shows where it applies.',
    false: 'The work leaves at least one decision to whoever does it, or does not say which of several approaches to take.',
  },
}

const DIFFICULTY = {
  type: 'score',
  instructions: 'Rate how much reasoning it takes to apply `work` to the file in `file_excerpt` correctly.',
  criteria: [
    'Mechanical. The change is a pattern to match and rewrite, and the file shows every place it applies.',
    'Moderate. The change is clear, but applying it correctly means following how this file uses the thing being changed.',
    'Hard. Applying the change correctly means reasoning about behaviour this file does not state on its face.',
  ],
}

/**
 * Whether this one item is the long job that xhigh effort is documented for.
 *
 * Thirty minutes is not a number picked here. platform.claude.com/docs/en/build-with-claude/effort scopes xhigh to
 * "long-horizon work (30+ min tasks)", so the question asks the literal thing that threshold names. It is asked per
 * item rather than assumed per stage, because the same workflow can carry a one-line rename and a rewrite.
 */
const LONG_HORIZON = {
  type: 'noul',
  instructions: 'Applying `work` to the file in `file_excerpt` is a long job: more than about thirty minutes of continuous work for an engineer who already knows this code.',
  criteria: {
    true: 'The work reaches many places in the file, or each place it reaches needs its own decision, so it runs well past half an hour.',
    false: 'The work is a handful of edits that an engineer who knows the file finishes well inside half an hour.',
  },
}

const VERIFY_NEEDS_REASONING = {
  type: 'noul',
  instructions: 'Deciding whether a reported instance of `concern` is real requires reading the code around the reported line and reasoning about how it behaves, rather than checking a pattern that is visible at the line itself.',
  criteria: {
    true: 'Settling it means following values, control flow, or lifetimes beyond the reported line.',
    false: 'The reported line either shows the problem or does not.',
  },
}

/**
 * One request for one work item on a fan-out stage.
 *
 * `file_line_count` is counted here rather than asked, because the jaggedness page states plainly that Jev does not
 * count reliably and that the error grows with the number.
 *
 * Every question is about the work and none is about which model should run it. That is deliberate: which rungs are
 * available is kelpie's own business, computed in policy.mjs from the session model, and sending that list as state
 * no question consults is the context-rot failure mode the jaggedness page lists. Asking Jev to rank models would
 * also be asking it to know what each model can do, which it has no grounding for.
 */
export const fanoutRequest = ({ work, path, contents, model = JEV_MODEL }) => ({
  model,
  state: {
    work,
    file_path: path,
    file_line_count: contents.split('\n').length,
    file_excerpt: excerpt(contents),
  },
  questions: { fully_specified: FULLY_SPECIFIED, difficulty: DIFFICULTY, long_horizon: LONG_HORIZON },
})

/** One request for the whole verify stage, because the findings it will judge do not exist yet when the gate runs. */
export const verifyRequest = ({ concern, pathCount, model = JEV_MODEL }) => ({
  model,
  state: { concern, file_count: pathCount },
  questions: { verify_needs_reasoning: VERIFY_NEEDS_REASONING },
})

// The prompt-level questions, asked by the delegation triage in prefer mode before the turn starts.
//
// They are separate wordings rather than the fan-out set reused, because the fan-out set is about one named file and
// at UserPromptSubmit no file has been named yet: nothing has been read, nothing has been searched, and `task` is all
// there is. A question that asks about `file_excerpt` when state carries none is a question answered against nothing.
//
// SUBSTANTIAL decides whether there is a route at all. READ_ONLY picks the agent. The other three are the same two
// ladders the spawn gate already runs on: difficulty picks the rung, and long_horizon with difficulty decides the
// review. None of them asks whether delegating costs less, because the answer to that is mostly arithmetic Jev
// cannot see: which model this session runs on, and how much cheaper the rung is. policy.mjs does that part.

/**
 * Whether the work is big enough to be worth handing over at all.
 *
 * A subagent on a cheaper model saves in proportion to the work it does, and costs a fixed amount to start: a
 * written brief, a cold context, and the result read back. So the size of the work is the one thing about it that
 * decides whether the saving can outrun the hand-off. One grep is cheaper done here at any price.
 *
 * It replaced a question that asked whether splitting the work across several workers costs less than one engineer
 * doing all of it. That question priced every worker the same as the session, so it could only ever be true for
 * work with independent parts, and it came back false on all ten real tickets kelpie's benchmark ran. The rung table
 * that picks a cheaper model was never reached, so prefer mode never once named one.
 */
const SUBSTANTIAL = {
  type: 'noul',
  instructions: 'Doing the work in `task` takes many steps: many searches, file reads, edits, or command runs, rather than one or two. `paths_named` is how many file paths `task` writes out.',
  criteria: {
    true: 'It needs many searches, reads, edits, or runs, well past what one or two steps can do.',
    false: 'One or two searches, reads, or edits finish it.',
  },
}

/** Read-only work has its own agent, because a lookup is the work a Haiku agent can do without a spec. */
const READ_ONLY = {
  type: 'noul',
  instructions: '`task` asks only for information: finding, listing, locating, reading, or explaining. Nothing is written.',
  criteria: {
    true: 'Answering it means reading and reporting back. No file is created or changed.',
    false: 'It asks for at least one file to be written, changed, created, or deleted.',
  },
}

const TASK_FULLY_SPECIFIED = {
  type: 'noul',
  instructions: '`task` states exactly what to do. Whoever does it has no design, naming, or approach decision left to make.',
  criteria: {
    true: 'The task names the exact change to make and says where it applies.',
    false: 'The task leaves at least one decision to whoever does it, or does not say which of several approaches to take.',
  },
}

const TASK_DIFFICULTY = {
  type: 'score',
  instructions: 'Rate how much reasoning it takes to do the work in `task` correctly.',
  criteria: [
    'Mechanical. The work is a pattern to match and rewrite, and `task` says where it applies.',
    'Moderate. The work is clear, but doing it correctly means following how the code already uses the thing being changed.',
    'Hard. Doing it correctly means reasoning about behaviour that has to be worked out from the code first.',
  ],
}

/** Same thirty-minute threshold as LONG_HORIZON, asked about the whole task rather than about one file of it. */
const TASK_LONG_HORIZON = {
  type: 'noul',
  instructions: 'The work in `task` is a long job: more than about thirty minutes of continuous work for an engineer who already knows this code.',
  criteria: {
    true: 'The work reaches many places, or each place it reaches needs its own decision, so it runs well past half an hour.',
    false: 'The work is a handful of edits that an engineer who knows the code finishes well inside half an hour.',
  },
}

/**
 * One request for one prompt. Five questions, one call, because the triage sits on the blocking path of the turn.
 *
 * `paths_named` is counted by the caller for the same reason `file_line_count` is: the jaggedness page states that
 * Jev does not count reliably and that the error grows with the number. It is in state because SUBSTANTIAL names
 * it, not as background.
 *
 * The session's model is not in state, even though the route turns on it. No question asks about it, and state no
 * question consults is the context-rot failure mode the jaggedness page lists. policy.mjs compares the rung with
 * the session model after the answers are back.
 *
 * The prompt is excerpted to the same budget as a file, so a pasted stack trace cannot push state past 32k.
 */
export const promptRequest = ({ task, pathsNamed = 0, model = JEV_MODEL }) => ({
  model,
  state: {
    task: excerpt(typeof task === 'string' ? task : ''),
    paths_named: pathsNamed,
  },
  questions: {
    substantial: SUBSTANTIAL,
    read_only: READ_ONLY,
    fully_specified: TASK_FULLY_SPECIFIED,
    difficulty: TASK_DIFFICULTY,
    long_horizon: TASK_LONG_HORIZON,
  },
})

/** Reject a malformed body rather than letting a missing field read as a confident zero downstream. */
export const parseAnswers = (body) => {
  if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') {
    throw new JevError('response carries no answers object', { terminal: true })
  }
  for (const [id, answer] of Object.entries(body.answers)) {
    if (!answer || typeof answer !== 'object') throw new JevError(`answer '${id}' is not an object`, { terminal: true })
    const value = answer.type === 'noul' ? answer.noul : answer.type === 'score' ? answer.score : undefined
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new JevError(`answer '${id}' of type '${answer.type}' carries no numeric value`, { terminal: true })
    }
  }
  return body.answers
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send one request, retrying only the statuses the API reference says to back off on.
 *
 * `perRequestTimeoutMs` exists because TypeSafe publishes no latency SLA; the only public per-call figures are
 * cookbook timings of 0.09 s to 0.31 s, which is one run rather than a commitment. A gate that can hang is a gate
 * that changes the arm it is supposed to measure, so it gets a deadline and a fallback instead of trust.
 *
 * `onAttempt` is called exactly once per HTTP attempt, before the retry decision, with the status, the latency and
 * the bytes that went out. It exists because a retried call and a first-time success are the same thing from the
 * outside, and a gate that sends a repository's contents to a third party should be able to say how many times it
 * did so and what came back. Once per attempt is the load-bearing part: the counts in the decision log are taken
 * straight from these lines. It never affects control flow, and a callback that throws is ignored.
 */
export const askJev = async ({ request, apiKey, perRequestTimeoutMs, url = JEV_URL, maxAttempts = 3, fetchImpl = fetch, sleepImpl = sleep, onAttempt = null }) => {
  let lastError = null
  const body = JSON.stringify(request)
  const note = (entry) => {
    if (!onAttempt) return
    try {
      onAttempt({ url, bytes_sent: Buffer.byteLength(body), ...entry })
    } catch {
      // The log never decides whether a request is retried.
    }
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // One HTTP attempt must produce exactly one record, or the log cannot be used to count what was sent. A body
    // that would not parse as JSON used to produce two: the inner catch wrote one, then the outer catch wrote
    // another, because a SyntaxError is not a JevError and fell through. The same bug labelled that attempt
    // `terminal` and then retried it.
    let recorded = false
    const record = (entry) => {
      recorded = true
      note(entry)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), perRequestTimeoutMs)
    const started = Date.now()
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
      if (response.ok) {
        // Noted around the parse, not after it, so a 200 carrying a body this cannot read is still recorded as a
        // call that was made and answered.
        try {
          const answers = parseAnswers(await response.json())
          record({ attempt, status: response.status, ms: Date.now() - started, outcome: 'ok' })
          return answers
        } catch (error) {
          // The outcome follows what happens next, not what threw. parseAnswers raises a terminal JevError and ends
          // it here; anything else, a body that is not JSON above all, is retried and must say so.
          const terminal = error instanceof JevError && error.terminal
          record({ attempt, status: response.status, ms: Date.now() - started, outcome: terminal ? 'terminal' : 'retryable', error: error.message })
          throw error
        }
      }
      const detail = `HTTP ${response.status}`
      const terminal = TERMINAL_STATUSES.has(response.status)
      record({ attempt, status: response.status, ms: Date.now() - started, outcome: terminal ? 'terminal' : 'retryable', error: detail })
      if (terminal) throw new JevError(detail, { terminal: true })
      lastError = new JevError(detail)
    } catch (error) {
      if (error instanceof JevError && error.terminal) throw error
      lastError = error instanceof JevError ? error : new JevError(String(error && error.message ? error.message : error))
      // Only the failures that never got as far as a response land here. Anything the block above already recorded
      // re-throws through this catch, and recording it twice would double every count taken from the log.
      if (!recorded) record({ attempt, status: null, ms: Date.now() - started, outcome: 'error', error: lastError.message })
    } finally {
      clearTimeout(timer)
    }
    if (attempt < maxAttempts) await sleepImpl(2 ** (attempt - 1) * 250)
  }
  throw lastError ?? new JevError('no attempt was made')
}
