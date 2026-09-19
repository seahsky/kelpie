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
 */
export const askJev = async ({ request, apiKey, perRequestTimeoutMs, url = JEV_URL, maxAttempts = 3, fetchImpl = fetch, sleepImpl = sleep }) => {
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), perRequestTimeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (response.ok) return parseAnswers(await response.json())
      const detail = `HTTP ${response.status}`
      if (TERMINAL_STATUSES.has(response.status)) throw new JevError(detail, { terminal: true })
      lastError = new JevError(detail)
    } catch (error) {
      if (error instanceof JevError && error.terminal) throw error
      lastError = error instanceof JevError ? error : new JevError(String(error && error.message ? error.message : error))
    } finally {
      clearTimeout(timer)
    }
    if (attempt < maxAttempts) await sleepImpl(2 ** (attempt - 1) * 250)
  }
  throw lastError ?? new JevError('no attempt was made')
}
