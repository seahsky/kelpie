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
  KELPIE_GATE_CONFIDENCE_FLOOR: '',
  CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '',
  // On for this file, because almost every test here is about what happens once prompts may be sent. The tests that
  // turn it off are the ones about the opt-in itself.
  CLAUDE_PLUGIN_OPTION_JEV_SEND_PROMPTS: 'true',
  // See delegation-triage.test.mjs: a user-scope config on the machine running the tests would otherwise decide them.
  CLAUDE_CONFIG_DIR: join(tmpdir(), 'kelpie-tests-no-user-config'),
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
      substantial: { type: 'noul', noul: overrides.substantial ?? 0.9 },
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

/** The note for one prompt under a session of the given model, or null model for a first prompt. */
const routeNote = async (answers, { prompt = MEASURED, model = 'claude-opus-5', env = {} } = {}) => {
  const cwd = await project('prefer')
  return withStub(answering(answers), async ({ url, seen }) => {
    const path = model === null ? null : await transcript(cwd, model)
    const output = await runHook(event(cwd, prompt, path), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url, ...env })
    return { note: output === '' ? null : noteOf(output), seen }
  })
}

test('prefer mode routes the prompt the A/B actually ran, with no threshold override anywhere', async () => {
  const { note, seen } = await routeNote({ difficulty: 1.1 })
  assert.equal(seen.length, 1, 'one call, five questions in it')
  assert.match(note, /decided with jev: delegate this/)
  assert.match(note, /kelpie:mech-executor with model: sonnet/)
  assert.match(note, /moderate \(difficulty 1\.1\)/)
})

test('an install nobody configured consults too, because prefer is the default', async () => {
  const cwd = await project(null)
  await withStub(answering({ difficulty: 1.1 }), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, MEASURED, await transcript(cwd, 'claude-opus-5')), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    }))
    assert.equal(seen.length, 1)
    assert.match(note, /kelpie:mech-executor with model: sonnet/)
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
    assert.deepEqual(Object.keys(body.questions), ['substantial', 'read_only', 'fully_specified', 'difficulty', 'long_horizon'])
    assert.deepEqual(Object.keys(body.state).sort(), ['paths_named', 'task'], 'the session model is compared here, never sent')
    assert.equal(body.state.paths_named, 3, 'counted here, because Jev is documented not to count reliably')
    assert.match(body.state.task, /^move every handler/)
  })
})

test('work too small to hand over is an answer, and it is still delivered', async () => {
  const { note } = await routeNote({ substantial: 0.1 })
  assert.match(note, /keep this in this session/)
  assert.match(note, /smaller than handing it over \(substantial 0\.1\)/)
  assert.doesNotMatch(note, /mech-executor/)
})

test('read-only work goes to kelpie:recon on haiku, not to Explore on the session model', async () => {
  const { note } = await routeNote({ readOnly: 0.9 }, { prompt: 'where is the session cookie read' })
  assert.match(note, /Send the lookup to kelpie:recon with model: haiku/)
  assert.doesNotMatch(note, /Explore/)
  assert.doesNotMatch(note, /Spec it in one shot/, 'recon takes a question, not an acceptance criterion')
})

test('an open decision is resolved here, and the rest goes to a cheaper model', async () => {
  const { note } = await routeNote({ specified: 0.2, difficulty: 1.1 }, { prompt: 'make the uploader nicer' })
  assert.match(note, /Resolve every open decision here first \(fully_specified 0\.2\)\. Then hand over what is left\./)
  assert.match(note, /kelpie:mech-executor with model: sonnet/)
})

test('a route on the session\'s own model is no route: hard, long work stays under an opus session, reviewed', async () => {
  const { note } = await routeNote({ difficulty: 2.0, longHorizon: 0.9 })
  assert.match(note, /keep this in this session/)
  assert.match(note, /cheapest model that fits is opus.*already runs on opus/)
  assert.match(note, /Then have kelpie:verifier with model: opus check the result/)
})

test('a sonnet session keeps moderate work and still hands mechanical work to haiku', async () => {
  assert.match((await routeNote({ difficulty: 1.1 }, { model: 'claude-sonnet-5' })).note, /keep this in this session/)
  assert.match((await routeNote({ difficulty: 0.1 }, { model: 'claude-sonnet-5' })).note, /kelpie:mech-executor with model: haiku/)
})

test('a route note never names an effort, because the Agent tool cannot pass one', async () => {
  for (const answers of [{ difficulty: 0.1 }, { difficulty: 1.1 }, { difficulty: 2.0, longHorizon: 0.9 }]) {
    const { note } = await routeNote(answers, { model: 'claude-fable-5' })
    assert.doesNotMatch(note, /effort/, JSON.stringify(answers))
  }
})

test('the first prompt of a session gets the route, and the price comparison goes to the model', async () => {
  // There is no assistant turn in the transcript yet, and no hook payload names the model. On run 02 that was every
  // consult, and a route that named no model inherited the session's, so no route could be cheaper.
  const { note } = await routeNote({ difficulty: 1.1 }, { model: null })
  assert.match(note, /costs less than doing this here if this session runs on a model above sonnet/)
  assert.match(note, /If this session runs on sonnet or a cheaper model, do the work here instead/)
  assert.match(note, /kelpie:mech-executor with model: sonnet/)
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

test('an unsure difficulty is read one level harder, and the route still arrives', async () => {
  const { note, seen } = await routeNote({ difficulty: 0.1, confidence: 0.3 })
  assert.equal(seen.length, 1)
  assert.match(note, /kelpie:mech-executor with model: sonnet/, 'unsure mechanical is read as moderate')
  assert.match(note, /read one level harder/)
})

test('an unsure answer that decided the route does leave the mode note standing', async () => {
  const cwd = await project('prefer')
  const unsure = () => ({
    status: 200,
    payload: {
      answers: {
        substantial: { type: 'noul', noul: 0.9, confidence: 0.2 },
        read_only: { type: 'noul', noul: 0.05 },
        fully_specified: { type: 'noul', noul: 0.95 },
        difficulty: { type: 'score', score: 0.1, confidence: 0.9 },
        long_horizon: { type: 'noul', noul: 0.05 },
      },
    },
  })
  await withStub(unsure, async ({ url, seen }) => {
    assert.equal(await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }), '')
    assert.equal(seen.length, 1, 'the call was made and the answer was declined')
  })
})

test('the answers run 02 got now name a route an Opus session can take', async () => {
  // Four of these are what a real call returned on the prompt above, recorded from kelpie's own benchmark. The fifth,
  // substantial, did not exist yet and is assumed true. The old question answered 0.2 here, and no route followed.
  const { note } = await routeNote({ substantial: 0.9, readOnly: 0.02, specified: 0.11, difficulty: 1.68, longHorizon: 0.49, confidence: 0.52 })
  assert.match(note, /delegate this/)
  assert.match(note, /Resolve every open decision here first/)
  assert.match(note, /kelpie:mech-executor with model: sonnet/)
  assert.doesNotMatch(note, /kelpie:verifier/, 'the review was difficulty\'s call, and difficulty was not sure enough')
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

test('prefer mode with no key sends nothing and falls back to its own note', async () => {
  const cwd = await project(null)
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, 'move every handler in src/api onto the new client'), { KELPIE_LOG: log })
  const decision = lineFor(await lines(log), 'decision')
  assert.equal(decision.mode, 'prefer')
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

test('a report a subagent hands back is never sent anywhere', async () => {
  // It opens with a plain sentence, not a tag, so the tag list never saw it. In a real session one of these, a
  // verifier's 6,789-character report with the repository's paths in it, went to Jev cut to 6,000 characters.
  const cwd = await project('prefer')
  await withStub(answering(), async ({ url, seen }) => {
    const handback = 'Another Claude session sent a message:\n<teammate-message teammate_id="verifier" color="green">\nThe design has two real flaws. Migrate every handler across the codebase before the first run.\n</teammate-message>'
    assert.equal(await runHook(event(cwd, handback), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', KELPIE_GATE_JEV_URL: url }), '')
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
    assert.equal(jev.session_model, 'opus')
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
    assert.equal(decision.route.only_above, null, 'the session model was known, so no condition went to the model')
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

test('resolveConsult is prefer mode with a key and the opt-in, and says why when it is not', () => {
  assert.deepEqual(resolveConsult({ mode: 'prefer', hasKey: true, allowed: true }), { on: true, reason: 'prefer mode with a key and jev_send_prompts on' })
  assert.equal(resolveConsult({ mode: 'prefer', hasKey: false, allowed: true }).on, false)
  assert.equal(resolveConsult({ mode: 'signals', hasKey: true, allowed: true }).on, false)
  assert.equal(resolveConsult({ mode: 'off', hasKey: true, allowed: true }).on, false)
  assert.equal(resolveConsult({ env: { KELPIE_TRIAGE_CONSULT: 'OFF' }, mode: 'prefer', hasKey: true, allowed: true }).on, false)
  assert.equal(resolveConsult({ env: { KELPIE_TRIAGE_CONSULT: 'auto' }, mode: 'prefer', hasKey: true, allowed: true }).on, true)
})

test('a key alone is not consent to send prompts', () => {
  const resolved = resolveConsult({ mode: 'prefer', hasKey: true })
  assert.equal(resolved.on, false, 'the opt-in defaults to off')
  assert.match(resolved.reason, /jev_send_prompts is not on/)
})

test('an install upgraded with only a spawn-gate key sends no prompt', async () => {
  // Before prefer was the default, a key turned on the spawn gate and nothing else unless the user also chose prefer
  // mode. That install has a key, no triage config, and has never seen the opt-in, which Claude Code then does not
  // export at all. It lands in prefer mode by default, and must not start sending prompts because of it.
  const cwd = await project(null)
  const log = join(cwd, 'kelpie.jsonl')
  await withStub(answering(), async ({ url, seen }) => {
    const note = noteOf(await runHook(event(cwd, 'move every handler in src/api onto the new client'), {
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      CLAUDE_PLUGIN_OPTION_JEV_SEND_PROMPTS: '',
      KELPIE_GATE_JEV_URL: url,
      KELPIE_LOG: log,
    }))
    assert.equal(seen.length, 0)
    assert.match(note, /prefer mode/, 'prefer mode still speaks, from keywords')
  })
  const decision = lineFor(await lines(log), 'decision')
  assert.equal(decision.mode_source, 'default')
  assert.equal(decision.consulted, false)
  assert.match(decision.consult_reason, /jev_send_prompts is not on/)
})

test('the opt-in reads as on only when it says true', async () => {
  for (const value of ['false', '0', 'no', 'yes', 'on', 'TRUE ']) {
    const cwd = await project('prefer')
    await withStub(answering(), async ({ url, seen }) => {
      await runHook(event(cwd, MEASURED), { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key', CLAUDE_PLUGIN_OPTION_JEV_SEND_PROMPTS: value, KELPIE_GATE_JEV_URL: url })
      assert.equal(seen.length, value.trim().toLowerCase() === 'true' ? 1 : 0, JSON.stringify(value))
    })
  }
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
  const answers = {
    substantial: { type: 'noul', noul: 0.8 },
    read_only: { type: 'noul', noul: 0.1 },
    fully_specified: { type: 'noul', noul: 0.9 },
    difficulty: { type: 'score', score: 0.2 },
    long_horizon: { type: 'noul', noul: 0.1 },
  }
  const note = renderRoute(decidePrompt(answers, { session: 'opus' }))
  assert.match(note, /kelpie:mech-executor with model: haiku/)
  assert.match(note, /A subagent on haiku costs less than doing this here/)
  assert.doesNotMatch(note, /keep this in this session/)
  assert.doesNotMatch(note, /if this session runs on/i, 'the session model was known, so the hook compared it itself')
  assert.doesNotMatch(note, /kelpie:verifier/, 'the review gate is one cell, and this is not it')
  assert.match(note, /Security-sensitive work stays in this session/)
})
