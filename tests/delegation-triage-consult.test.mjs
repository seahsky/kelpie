// Runs hooks/delegation-triage/triage.mjs with prefer mode's Jev consult on, against a local stub rather than the
// real API, so these tests need no key and spend nothing.
//
// The claim under test is the one the keyword triage could not make. kelpie's paired A/B ran ten real tickets in
// prefer mode and the note fired on none of them, because the prompt scores zero on every signal family. Here the
// same prompt gets a route, and the route comes from an answer about the work rather than from the words in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConsult } from '../hooks/delegation-triage/config.mjs'
import { renderRoute } from '../hooks/delegation-triage/consult.mjs'
import { decidePrompt } from '../hooks/jev-gate/policy.mjs'

const HOOK = new URL('../hooks/delegation-triage/triage.mjs', import.meta.url).pathname

/** Every variable the hook reads, cleared, so an ambient shell cannot decide a test. */
const BASE = {
  KELPIE_TRIAGE: '',
  KELPIE_TRIAGE_THRESHOLD: '',
  KELPIE_TRIAGE_CONSULT: '',
  KELPIE_LOG: '',
  KELPIE_LOG_PROMPTS: '',
  KELPIE_GATE_JEV_URL: '',
  KELPIE_GATE_EFFORT_CEILING: '',
  CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '',
}

const runHook = (event, env = {}) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [HOOK], { env: { ...process.env, ...BASE, ...env } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}`))
    else resolve(stdout.trim())
  })
  child.stdin.end(JSON.stringify(event))
})

/** A stub that records every request body, so a test can assert that nothing went on the wire. */
const stubServer = (handler) => new Promise((resolve) => {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push(body)
      const { status, payload } = handler(body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1/systemone` }))
})

const answering = (overrides = {}) => () => ({
  status: 200,
  payload: {
    answers: {
      delegation_saves: { type: 'noul', noul: overrides.saves ?? 0.9 },
      read_only: { type: 'noul', noul: overrides.readOnly ?? 0.05 },
      fully_specified: { type: 'noul', noul: overrides.specified ?? 0.95 },
      difficulty: { type: 'score', score: overrides.difficulty ?? 0.1, confidence: overrides.confidence ?? 0.9 },
      long_horizon: { type: 'noul', noul: overrides.longHorizon ?? 0.05 },
    },
  },
})

const project = async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'kelpie-consult-'))
  if (mode !== null) {
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude', 'kelpie-triage.json'), JSON.stringify({ mode }))
  }
  return dir
}

/** One main-thread assistant turn, which is where the session model is read from. */
const transcript = async (dir, model) => {
  const path = join(dir, 'transcript.jsonl')
  await writeFile(path, `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model, content: [] } })}\n`)
  return path
}

const event = (cwd, prompt, transcriptPath = null) => ({
  session_id: 'test-session',
  cwd,
  transcript_path: transcriptPath,
  effort: { level: 'high' },
  hook_event_name: 'UserPromptSubmit',
  prompt,
})

const lines = async (log) => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
const lineFor = (entries, name) => entries.find((entry) => entry.event === name)

const noteOf = (output) => JSON.parse(output).hookSpecificOutput.additionalContext

// The prompt template kelpie's own paired benchmark runs, with its ticket number and branch replaced. It scores zero
// on every signal family, which is why prefer mode at its own bar said nothing on any of the ten tickets.
const MEASURED = 'GitHub issue #1234 in this repository is your task. Read the issue, study the code it concerns, implement it, and open a pull request.\n\nYou are already on branch ab/1234/A, created from the base commit. Commit your work there, push it, and open the PR against the main branch. Do not switch branches, and do not work on any other issue.'

const withStub = async (handler, body) => {
  const { server, seen, url } = await stubServer(handler)
  try {
    return await body({ url, seen })
  } finally {
    server.close()
  }
}

test('prefer mode routes the prompt the A/B actually ran, with no threshold override anywhere', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 1.1 }), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.equal(seen.length, 1, 'one call, five questions in it')
    assert.match(note, /decided with jev: delegate this/)
    assert.match(note, /kelpie:mech-executor, model sonnet, effort medium/)
    assert.match(note, /moderate \(difficulty 1\.1\)/)
  })
})

test('the five questions go in one request, with the prompt and a count kelpie did itself', async () => {
  const cwd = await project('prefer')
  await withStub(answering(), async ({ url, seen }) => {
    await runHook(event(cwd, 'move every handler in src/api/a.ts, src/api/b.ts and src/api/c.ts onto the new client'), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    })
    const [body] = seen
    assert.deepEqual(Object.keys(body.questions), ['delegation_saves', 'read_only', 'fully_specified', 'difficulty', 'long_horizon'])
    assert.deepEqual(Object.keys(body.state).sort(), ['paths_named', 'task'])
    assert.equal(body.state.paths_named, 3, 'counted here, because Jev is documented not to count reliably')
    assert.match(body.state.task, /^move every handler/)
  })
})

test('jev saying the session is cheaper is an answer, and it is still delivered', async () => {
  // The inversion prefer mode asks for: delegate unless doing all of it in this session costs less. Both answers are worth
  // saying, because the mode's own note said neither.
  const cwd = await project('prefer')
  await withStub(answering({ saves: 0.1 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }))
    assert.match(note, /keep this in this session/)
    assert.match(note, /delegation_saves 0\.1/)
    assert.doesNotMatch(note, /mech-executor/)
  })
})

test('read-only work goes to the built-in Explore agent, at no named tier', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ readOnly: 0.9 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, 'where is the session cookie read'), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }))
    assert.match(note, /built-in Explore agent/)
    assert.doesNotMatch(note, /Spec it in one shot/, 'recon takes a question, not an acceptance criterion')
  })
})

test('an open decision keeps the work at the session tier and names the precondition', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ specified: 0.2 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, 'make the uploader nicer', await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.match(note, /Resolve every open decision here first/)
    assert.match(note, /general-purpose, at this session's own model/)
    assert.doesNotMatch(note, /model haiku|model sonnet/, 'an open decision costs the route its tiering, not its delegation')
  })
})

test('hard and long-horizon work gets the top reachable rung and an independent review', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 2.0, longHorizon: 0.9 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.match(note, /kelpie:mech-executor, model opus, effort xhigh/)
    assert.match(note, /kelpie:verifier check the result, model opus, effort xhigh/)
  })
})

test('the route never climbs above the session model', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 2.0, longHorizon: 0.9 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-sonnet-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.match(note, /kelpie:mech-executor, model sonnet, effort xhigh/)
    assert.match(note, /kelpie:verifier check the result, model sonnet/)
  })
})

test('the effort ceiling clamps the route, so a triage cannot outrun the spawn gate', async () => {
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 2.0, longHorizon: 0.9 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_GATE_EFFORT_CEILING: 'medium',
    }))
    assert.match(note, /effort medium/)
    assert.doesNotMatch(note, /xhigh/)
  })
})

test('the first prompt of a session still gets a route, with no model named', async () => {
  // There is no assistant turn in the transcript yet, so the session model cannot be read. The spawn gate emits
  // nothing on that, because it cannot show a route is downward. Here it names no model, which inherits the
  // session's and so cannot be above it.
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 2.0, longHorizon: 0.9 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }))
    assert.match(note, /kelpie:mech-executor, at this session's model, effort xhigh/)
  })
})

test('a dead endpoint leaves prefer mode saying exactly what it said before the consult existed', async () => {
  const cwd = await project('prefer')
  const dead = 'http://127.0.0.1:1/v1/systemone'
  const key = { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: dead }
  assert.equal(await runHook(event(cwd, MEASURED), key), '', 'a score of zero is silent at prefer mode\'s own bar')
  const note = noteOf(await runHook(event(cwd, 'review the new session handler', null), key))
  assert.match(note, /prefer mode/)
  assert.match(note, /kelpie:mech-executor/, 'the mode note, not a route')
})

test('an unsure difficulty costs the route its tier, and the route still arrives', async () => {
  // The first real call kelpie made came back with difficulty at confidence 0.52 against a floor of 0.6, and the
  // flat floor discarded the whole verdict over it. The arm then ran as a copy of the arm it was being contrasted
  // against. An unsure rung is now a rung nobody names, not an answer nobody gets.
  const cwd = await project('prefer')
  await withStub(answering({ difficulty: 1.68, confidence: 0.52 }), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.equal(seen.length, 1)
    assert.match(note, /kelpie:mech-executor, at this session's own model and effort/)
    assert.match(note, /not confident enough to act on/)
    assert.doesNotMatch(note, /model sonnet|model haiku|model opus/)
  })
})

test('an unsure answer that decided the route does leave the mode note standing', async () => {
  const cwd = await project('prefer')
  const unsureSaves = () => ({
    status: 200,
    payload: {
      answers: {
        delegation_saves: { type: 'noul', noul: 0.9, confidence: 0.2 },
        read_only: { type: 'noul', noul: 0.05 },
        fully_specified: { type: 'noul', noul: 0.95 },
        difficulty: { type: 'score', score: 0.1, confidence: 0.9 },
        long_horizon: { type: 'noul', noul: 0.05 },
      },
    },
  })
  await withStub(unsureSaves, async ({ url, seen }) => {
    assert.equal(await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }), '')
    assert.equal(seen.length, 1, 'the call was made and the answer was declined')
  })
})

test('the answers the run actually got produce a route, where they used to produce nothing', async () => {
  // The answers a real call actually returned on the prompt above, recorded from kelpie's own benchmark.
  const cwd = await project('prefer')
  await withStub(answering({ saves: 0.2, readOnly: 0.02, specified: 0.11, difficulty: 1.68, longHorizon: 0.5, confidence: 0.52 }), async ({ url }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.match(note, /keep this in this session/)
    assert.match(note, /delegation_saves 0\.2/)
    assert.doesNotMatch(note, /kelpie:verifier/, 'the review was difficulty\'s call, and difficulty was not sure enough')
  })
})

test('the other modes send nothing, even with a key configured', async () => {
  for (const mode of ['signals', 'always']) {
    const cwd = await project(mode)
    await withStub(answering(), async ({ url, seen }) => {
      const log = join(cwd, 'kelpie.jsonl')
      await runHook(event(cwd, 'move every handler in src/api onto the new client'), {
        CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
        KELPIE_GATE_JEV_URL: url,
        KELPIE_LOG: log,
      })
      assert.equal(seen.length, 0, `${mode} mode confirms a default that was right 180 times out of 180`)
      const decision = lineFor(await lines(log), 'decision')
      assert.equal(decision.consulted, false)
      assert.match(decision.consult_reason, /prefer mode only/)
      assert.equal(decision.decided_by, 'signals')
    })
  }
})

test('prefer mode with no key is prefer mode as it shipped', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, 'move every handler in src/api onto the new client'), { KELPIE_LOG: log })
  const decision = lineFor(await lines(log), 'decision')
  assert.equal(decision.consulted, false)
  assert.match(decision.consult_reason, /no jev_api_key/)
})

test('one variable turns the consult off without turning prefer mode off', async () => {
  const cwd = await project('prefer')
  await withStub(answering(), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, 'move every handler in src/api onto the new client'), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_TRIAGE_CONSULT: 'off',
    }))
    assert.equal(seen.length, 0, 'nothing on the wire is the whole point of the setting')
    assert.match(note, /prefer mode/)
  })
})

test('a notice Claude Code generated is never sent anywhere', async () => {
  // A background Bash call finishing enqueues one of these as a prompt. On one run of the A/B, 12 of the 13 prompts
  // the triage saw were these. Consulting about them would put shell job completions on the wire.
  const cwd = await project('prefer')
  await withStub(answering(), async ({ url, seen }) => {
    const notification = '<task-notification>\n<task-id>bp764e8lk</task-id>\nBackground task completed: build across every package\n</task-notification>'
    assert.equal(await runHook(event(cwd, notification), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }), '')
    assert.equal(await runHook(event(cwd, '/kelpie:audit-many-files'), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }), '')
    assert.equal(seen.length, 0)
  })
})

test('the log records the call, the answers, the route, and who decided', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  await withStub(answering({ difficulty: 1.1 }), async ({ url }) => {
    await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_LOG: log,
    })
    const entries = await lines(log)
    assert.deepEqual(entries.map((entry) => entry.event), ['jev_request', 'jev_attempt', 'jev_decision', 'decision'])

    const request = lineFor(entries, 'jev_request')
    assert.equal(request.stage, 'prompt')
    assert.equal(request.url, url)
    assert.equal(request.excerpt_chars, MEASURED.length)
    assert.match(request.excerpt_sha256, /^[0-9a-f]{16}$/)
    assert.equal(request.task, undefined, 'a prompt carries whatever the user typed into it')

    const attempt = lineFor(entries, 'jev_attempt')
    assert.equal(attempt.status, 200)
    assert.equal(attempt.outcome, 'ok')
    assert.ok(attempt.bytes_sent > 0)

    const jev = lineFor(entries, 'jev_decision')
    assert.equal(jev.asked, true)
    assert.equal(jev.answers.difficulty.score, 1.1)
    assert.equal(jev.decision.agentType, 'kelpie:mech-executor')
    assert.equal(jev.decision.model, 'sonnet')

    const decision = lineFor(entries, 'decision')
    assert.equal(decision.consulted, true)
    assert.equal(decision.decided_by, 'jev')
    assert.equal(decision.session_model, 'opus')
    assert.equal(decision.emitted, true)
    assert.equal(decision.score, 0, 'the keyword score is still recorded, and it still disagrees')
    assert.equal(decision.route.delegate, true)
    assert.equal(decision.route.model, 'sonnet')
    assert.ok(decision.note_chars > 0)
  })
})

test('the prompt reaches the log only when it is asked for by name', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'verbose.jsonl')
  await withStub(answering(), async ({ url }) => {
    await runHook(event(cwd, MEASURED), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_LOG: log,
      KELPIE_LOG_PROMPTS: '1',
    })
    const entries = await lines(log)
    assert.equal(lineFor(entries, 'jev_request').task, MEASURED)
    assert.equal(lineFor(entries, 'decision').prompt, MEASURED)
  })
})

test('a 401 is not retried, and the turn is not failed over it', async () => {
  const cwd = await project('prefer')
  await withStub(() => ({ status: 401, payload: { error: 'bad key' } }), async ({ url, seen }) => {
    const log = join(cwd, 'kelpie.jsonl')
    assert.equal(await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'wrong', KELPIE_GATE_JEV_URL: url, KELPIE_LOG: log }), '')
    assert.equal(seen.length, 1)
    const jev = lineFor(await lines(log), 'jev_decision')
    assert.match(jev.reason, /no route from jev: HTTP 401/)
  })
})

test('resolveConsult is prefer mode with a key, and says why when it is not', () => {
  assert.deepEqual(resolveConsult({ mode: 'prefer', hasKey: true }), { on: true, reason: 'prefer mode with a key' })
  assert.equal(resolveConsult({ mode: 'prefer', hasKey: false }).on, false)
  assert.equal(resolveConsult({ mode: 'signals', hasKey: true }).on, false)
  assert.equal(resolveConsult({ mode: 'off', hasKey: true }).on, false)
  assert.equal(resolveConsult({ env: { KELPIE_TRIAGE_CONSULT: 'OFF' }, mode: 'prefer', hasKey: true }).on, false)
  assert.equal(resolveConsult({ env: { KELPIE_TRIAGE_CONSULT: 'auto' }, mode: 'prefer', hasKey: true }).on, true)
})

test('a key of whitespace is no key, and nothing goes on the wire for it', async () => {
  // The raw presence check passed on ' ' while settings() trimmed it to '', so the consult ran and POSTed the
  // prompt with an empty bearer token. A misconfiguration must read as "no key", not as "send it anyway".
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  await withStub(answering(), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, 'move every handler in src/api onto the new client'), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '   ',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_LOG: log,
    }))
    assert.equal(seen.length, 0)
    assert.match(note, /prefer mode/, 'the mode note still stands')
  })
  const decision = lineFor(await lines(log), 'decision')
  assert.equal(decision.consulted, false)
  assert.match(decision.consult_reason, /no jev_api_key/)
})

test('a typo in the switch that sends prompts away leaves them here', () => {
  // The opposite of how resolveMode treats an unrecognised value, and deliberately so. Somebody who wrote `no` meant
  // off, and reading that as the default would put their prompts on the wire.
  for (const setting of ['no', 'false', '0', 'disabled']) {
    const resolved = resolveConsult({ env: { KELPIE_TRIAGE_CONSULT: setting }, mode: 'prefer', hasKey: true })
    assert.equal(resolved.on, false, setting)
    assert.match(resolved.reason, /nothing is sent/)
  }
})

test('a route note names the route and the answer behind it, and never argues both ways', () => {
  const ceilings = { model: 'opus', effort: 'xhigh' }
  const answers = {
    delegation_saves: { type: 'noul', noul: 0.8 },
    read_only: { type: 'noul', noul: 0.1 },
    fully_specified: { type: 'noul', noul: 0.9 },
    difficulty: { type: 'score', score: 0.2 },
    long_horizon: { type: 'noul', noul: 0.1 },
  }
  const note = renderRoute(decidePrompt(answers, ceilings))
  assert.match(note, /model haiku, which takes no effort parameter/)
  assert.doesNotMatch(note, /keep this in this session/)
  assert.doesNotMatch(note, /kelpie:verifier/, 'the review gate is one cell, and this is not it')
  assert.match(note, /Security-sensitive work stays in this session/)
})
