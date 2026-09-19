// Runs hooks/jev-gate/gate.mjs the way Claude Code runs it: as a subprocess fed one PreToolUse event on stdin.
// Jev is a local stub rather than the real API, so these tests need no key and spend nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const GATE = new URL('../hooks/jev-gate/gate.mjs', import.meta.url).pathname

const runGate = (event, env) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [GATE], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}`))
    else resolve(stdout.trim())
  })
  child.stdin.end(JSON.stringify(event))
})

const stubServer = (handler) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const { status, payload } = handler(body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/systemone` }))
})

/** A transcript holding one main-thread assistant turn, which is where the gate reads the session model from. */
const transcript = async (dir, model) => {
  const path = join(dir, 'transcript.jsonl')
  await writeFile(path, `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model, content: [] } })}\n`)
  return path
}

const workspace = async (files) => {
  const dir = await mkdtemp(join(tmpdir(), 'kelpie-gate-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents)
  return dir
}

const auditEvent = (cwd, transcriptPath = null) => ({
  session_id: 'test-session',
  cwd,
  transcript_path: transcriptPath,
  effort: { level: 'high' },
  hook_event_name: 'PreToolUse',
  tool_name: 'Workflow',
  tool_input: { name: 'audit-many-files', args: { paths: ['src/a.ts', 'src/b.ts'], concern: 'off-by-one errors' } },
})

const FILES = { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 2\n' }

test('with no key and no mode set, the gate emits nothing at all', async () => {
  // This is an unconfigured kelpie. The Workflow call must reach the script exactly as the model wrote it.
  const cwd = await workspace(FILES)
  const out = await runGate(auditEvent(cwd), { KELPIE_GATE_MODE: '', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '' })
  assert.equal(out, '')
})

test('a key on its own turns the gate on, with no mode variable needed', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
    : { status: 200, payload: { answers: { fully_specified: { type: 'noul', noul: 0.95 }, difficulty: { type: 'score', score: 0.1, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 } } } })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), {
      KELPIE_GATE_MODE: '',
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_JEV_URL: url,
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.byPath['src/a.ts'].source, 'jev')
  } finally {
    server.close()
  }
})

test('a non-Workflow tool call is passed through untouched', async () => {
  const out = await runGate({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { KELPIE_GATE_MODE: 'static' })
  assert.equal(out, '')
})

test('a Workflow call whose args name no gateable work is passed through untouched', async () => {
  const out = await runGate(
    { tool_name: 'Workflow', tool_input: { name: 'something-else', args: { target: 'a diff' } } },
    { KELPIE_GATE_MODE: 'static' },
  )
  assert.equal(out, '')
})

test('static mode emits decisions that pin nothing, so the shipped roles stand', async () => {
  const cwd = await workspace(FILES)
  const out = await runGate(auditEvent(cwd), { KELPIE_GATE_MODE: 'static' })
  const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
  for (const decision of Object.values(gate.byPath)) {
    assert.equal(decision.agentType, null)
    assert.equal(decision.model, null)
    assert.equal(decision.effort, null)
  }
  assert.equal(gate.verify.agentType, 'kelpie:verifier')
  assert.equal(gate.verify.model, null)
})

test('the rewritten input keeps every other field the model wrote', async () => {
  const cwd = await workspace(FILES)
  const event = auditEvent(cwd)
  const out = await runGate(event, { KELPIE_GATE_MODE: 'static' })
  const updated = JSON.parse(out).hookSpecificOutput.updatedInput
  assert.equal(updated.name, 'audit-many-files')
  assert.deepEqual(updated.args.paths, event.tool_input.args.paths)
  assert.equal(updated.args.concern, event.tool_input.args.concern)
})

test('jev mode routes each path on its own answers and logs every call', async () => {
  const cwd = await workspace(FILES)
  const log = join(cwd, 'gate.jsonl')
  const seen = []
  const { server, url } = await stubServer((body) => {
    seen.push(body)
    if (body.questions.verify_needs_reasoning) {
      return { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
    }
    const hard = body.state.file_path === 'src/b.ts'
    return {
      status: 200,
      payload: {
        answers: {
          fully_specified: { type: 'noul', noul: 0.95 },
          difficulty: { type: 'score', score: hard ? 1.0 : 0.1, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 },
        },
      },
    }
  })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_LOG: log,
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.deepEqual(gate.byPath['src/a.ts'], { agentType: null, model: 'haiku', effort: null, review: null, source: 'jev', reason: gate.byPath['src/a.ts'].reason })
    assert.deepEqual([gate.byPath['src/b.ts'].model, gate.byPath['src/b.ts'].effort], ['sonnet', 'medium'])
    assert.deepEqual([gate.verify.agentType, gate.verify.model, gate.verify.effort], ['kelpie:verifier', 'haiku', null])
    // Three questions per path, and the long-horizon one is asked per item rather than once per stage.
    assert.deepEqual(Object.keys(seen[0].questions), ['fully_specified', 'difficulty', 'long_horizon'])
    // Every number the question depends on is computed here, never asked, per the jaggedness page.
    assert.equal(seen[0].state.file_line_count, 2)
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(entries.length, 1)
    assert.equal(entries[0].event, 'gated')
    assert.equal(entries[0].calls.length, 3, 'two paths plus one verify-stage decision')
  } finally {
    server.close()
  }
})

test('the session model is a hard ceiling even when Jev asks for more', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.9 } } } }
    : { status: 200, payload: { answers: { fully_specified: { type: 'noul', noul: 0.95 }, difficulty: { type: 'score', score: 1.0, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 } } } })
  try {
    const out = await runGate(auditEvent(cwd), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_MODEL_CEILING: 'haiku',
      KELPIE_GATE_EFFORT_CEILING: 'low',
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.byPath['src/a.ts'].model, 'haiku')
    assert.equal(gate.verify.model, 'haiku', 'sonnet was asked for, haiku is the ceiling')
    assert.equal(gate.verify.effort, null, 'haiku takes no effort parameter, so none survives the clamp')
  } finally {
    server.close()
  }
})

test('an unreachable Jev falls back to the shipped default and says so in the log', async () => {
  const cwd = await workspace(FILES)
  const log = join(cwd, 'gate.jsonl')
  const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), {
    KELPIE_GATE_MODE: 'jev',
    // Port 1 refuses immediately, so the test does not wait on a timeout.
    KELPIE_GATE_JEV_URL: 'http://127.0.0.1:1/v1/systemone',
    CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
    KELPIE_GATE_LOG: log,
    KELPIE_GATE_REQUEST_MS: '200',
  })
  const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
  assert.equal(gate.byPath['src/a.ts'].source, 'fallback')
  assert.equal(gate.byPath['src/a.ts'].model, null)
  assert.equal(gate.verify.agentType, 'kelpie:verifier')
  const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(entries[0].calls.every((call) => call.decision.source === 'fallback'))
})

test('jev mode with no key records the misconfiguration rather than silently becoming the static arm', async () => {
  const cwd = await workspace(FILES)
  const log = join(cwd, 'gate.jsonl')
  await runGate(auditEvent(cwd), {
    KELPIE_GATE_MODE: 'jev',
    KELPIE_GATE_JEV_URL: 'http://127.0.0.1:1/v1/systemone',
    KELPIE_GATE_LOG: log,
    KELPIE_GATE_REQUEST_MS: '200',
    CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '',
  })
  const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(entries[0].event, 'misconfigured')
})

test('a malformed answer body falls back rather than routing on a missing number', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer(() => ({ status: 200, payload: { answers: { difficulty: { type: 'score' } } } }))
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), { KELPIE_GATE_MODE: 'jev', KELPIE_GATE_JEV_URL: url, CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key' })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.byPath['src/a.ts'].source, 'fallback')
  } finally {
    server.close()
  }
})

test('a file the gate cannot read falls back for that path only', async () => {
  const cwd = await workspace({ 'src/a.ts': 'export const a = 1\n' })
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
    : { status: 200, payload: { answers: { fully_specified: { type: 'noul', noul: 0.95 }, difficulty: { type: 'score', score: 0.1, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 } } } })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), { KELPIE_GATE_MODE: 'jev', KELPIE_GATE_JEV_URL: url, CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key' })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.byPath['src/a.ts'].model, 'haiku')
    assert.equal(gate.byPath['src/b.ts'].source, 'fallback')
    assert.equal(gate.byPath['src/b.ts'].reason, 'file unreadable')
  } finally {
    server.close()
  }
})

/**
 * Every file the gate reads is sent to the API, so the set of readable files is the set of uploadable files.
 * `args.paths` is model-written, not a scoped list, so these three shapes are the ones that must never be read:
 * an absolute path, a relative walk out, and a symlink inside the workspace aimed outside it.
 */
test('a path outside cwd is never read, so its contents are never sent', async () => {
  const cwd = await workspace(FILES)
  const outside = join(await mkdtemp(join(tmpdir(), 'kelpie-secret-')), 'id_rsa')
  await writeFile(outside, 'CANARY_PRIVATE_KEY_BODY\n')
  await symlink(outside, join(cwd, 'src/link.ts'))

  const bodies = []
  const { server, url } = await stubServer((body) => {
    bodies.push(body)
    return body.questions.verify_needs_reasoning
      ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
      : { status: 200, payload: { answers: { fully_specified: { type: 'noul', noul: 0.95 }, difficulty: { type: 'score', score: 0.1, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 } } } }
  })
  try {
    const event = auditEvent(cwd, await transcript(cwd, 'claude-opus-5'))
    // A relative walk to a file that really exists outside cwd, so the refusal proves containment rather than absence.
    const walk = relative(cwd, outside)
    event.tool_input.args.paths = ['src/a.ts', outside, walk, 'src/link.ts']
    const out = await runGate(event, { KELPIE_GATE_MODE: 'jev', KELPIE_GATE_JEV_URL: url, CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key' })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate

    assert.equal(gate.byPath['src/a.ts'].model, 'haiku', 'a path inside cwd still routes normally')
    for (const path of [outside, walk, 'src/link.ts']) {
      assert.equal(gate.byPath[path].source, 'fallback', `${path} should fall back`)
      assert.equal(gate.byPath[path].reason, 'file outside cwd', `${path} should be refused for being outside cwd`)
    }

    const sent = JSON.stringify(bodies)
    assert.ok(!sent.includes('CANARY_PRIVATE_KEY_BODY'), 'no outside-cwd file contents may reach the API')
    assert.equal(bodies.filter((b) => b.state && b.state.file_excerpt !== undefined).length, 1, 'only the one in-cwd file is uploaded')
  } finally {
    server.close()
  }
})

test('a migration call is gated on args.transformation and asks for no verify decision', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer(() => ({
    status: 200,
    payload: { answers: { fully_specified: { type: 'noul', noul: 0.2 }, difficulty: { type: 'score', score: 0.1, confidence: 0.9 }, long_horizon: { type: 'noul', noul: 0.05 } } },
  }))
  try {
    const out = await runGate({
      cwd,
      transcript_path: await transcript(cwd, 'claude-opus-5'),
      tool_name: 'Workflow',
      tool_input: { name: 'migrate-in-parallel', args: { paths: ['src/a.ts'], transformation: 'convert callbacks to async/await', checkCommand: 'node --test' } },
    }, { KELPIE_GATE_MODE: 'jev', KELPIE_GATE_JEV_URL: url, CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key' })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.verify, null)
    // fully_specified below the midpoint sends it to the session tier, whatever the difficulty said.
    assert.equal(gate.byPath['src/a.ts'].agentType, null)
  } finally {
    server.close()
  }
})

test('a fable session sends its hard spawns down to opus, not back to fable', async () => {
  // The case with the most to win: every spawn moved off the session model here moves off the priciest model there is.
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.9 } } } }
    : {
      status: 200,
      payload: {
        answers: {
          fully_specified: { type: 'noul', noul: 0.95 },
          difficulty: { type: 'score', score: 2.0, confidence: 0.95 },
          long_horizon: { type: 'noul', noul: 0.9 },
        },
      },
    })
  try {
    const log = join(cwd, 'gate.jsonl')
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-fable-5-1')), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
      KELPIE_GATE_LOG: log,
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.deepEqual([gate.byPath['src/a.ts'].model, gate.byPath['src/a.ts'].effort], ['opus', 'xhigh'])
    assert.notEqual(gate.byPath['src/a.ts'].model, 'fable', 'fable is never a spawn target, only a session model')
    assert.deepEqual(gate.byPath['src/a.ts'].review, { agentType: 'kelpie:verifier', model: 'opus', effort: 'xhigh' })
    const entry = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0])
    assert.equal(entry.session_model, 'fable')
    assert.equal(entry.ceilings.model, 'opus')
    assert.deepEqual(entry.available_models, ['haiku', 'sonnet', 'opus'])
  } finally {
    server.close()
  }
})

test('a sonnet session cannot be routed up, however hard the work is', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.9 } } } }
    : {
      status: 200,
      payload: {
        answers: {
          fully_specified: { type: 'noul', noul: 0.95 },
          difficulty: { type: 'score', score: 2.0, confidence: 0.95 },
          long_horizon: { type: 'noul', noul: 0.9 },
        },
      },
    })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-sonnet-5')), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.deepEqual([gate.byPath['src/a.ts'].model, gate.byPath['src/a.ts'].effort], ['sonnet', 'xhigh'])
  } finally {
    server.close()
  }
})

test('an unresolvable session model emits nothing rather than guessing a ceiling', async () => {
  // Without a known ceiling the gate cannot show that a route is downward, so it leaves every frontmatter pin alone.
  const cwd = await workspace(FILES)
  const log = join(cwd, 'gate.jsonl')
  const out = await runGate(auditEvent(cwd, join(cwd, 'no-such-transcript.jsonl')), {
    KELPIE_GATE_MODE: 'jev',
    KELPIE_GATE_JEV_URL: 'http://127.0.0.1:1/v1/systemone',
    CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
    KELPIE_GATE_LOG: log,
  })
  assert.equal(out, '')
  const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(entries[0].event, 'skipped')
  assert.match(entries[0].reason, /session model unresolved/)
})

test('static mode needs no session model, because it names no rung', async () => {
  const cwd = await workspace(FILES)
  const out = await runGate(auditEvent(cwd, join(cwd, 'no-such-transcript.jsonl')), { KELPIE_GATE_MODE: 'static' })
  const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
  assert.equal(gate.byPath['src/a.ts'].model, null)
})

test('the session effort the payload carries is recorded, so a route can be read as up or down later', async () => {
  const cwd = await workspace(FILES)
  const log = join(cwd, 'gate.jsonl')
  await runGate({ ...auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), effort: { level: 'low' } }, {
    KELPIE_GATE_MODE: 'static',
    KELPIE_GATE_LOG: log,
  })
  const entry = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0])
  assert.equal(entry.session_effort, 'low')
  assert.equal(entry.session_model, 'opus')
})

test('a hard and long item carries a review at the top rung, and an easy one carries none', async () => {
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => {
    if (body.questions.verify_needs_reasoning) {
      return { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
    }
    const hard = body.state.file_path === 'src/b.ts'
    return {
      status: 200,
      payload: {
        answers: {
          fully_specified: { type: 'noul', noul: 0.95 },
          difficulty: { type: 'score', score: hard ? 2.0 : 0.1, confidence: 0.95 },
          long_horizon: { type: 'noul', noul: hard ? 0.9 : 0.05 },
        },
      },
    }
  })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-opus-5')), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.equal(gate.byPath['src/a.ts'].review, null, 'a mechanical item is settled by the check, per the 74.8% null')
    assert.deepEqual(gate.byPath['src/b.ts'].review, { agentType: 'kelpie:verifier', model: 'opus', effort: 'xhigh' })
    // The reviewed cell is the one already at the top rung, so the review buys independence rather than capability.
    assert.deepEqual([gate.byPath['src/b.ts'].model, gate.byPath['src/b.ts'].effort], ['opus', 'xhigh'])
  } finally {
    server.close()
  }
})

test('a review never outruns the session, so a sonnet session reviews at sonnet', async () => {
  // Same answers as the fable and opus cases: hard and long.
  
  const cwd = await workspace(FILES)
  const { server, url } = await stubServer((body) => body.questions.verify_needs_reasoning
    ? { status: 200, payload: { answers: { verify_needs_reasoning: { type: 'noul', noul: 0.1 } } } }
    : {
      status: 200,
      payload: {
        answers: {
          fully_specified: { type: 'noul', noul: 0.95 },
          difficulty: { type: 'score', score: 2.0, confidence: 0.95 },
          long_horizon: { type: 'noul', noul: 0.9 },
        },
      },
    })
  try {
    const out = await runGate(auditEvent(cwd, await transcript(cwd, 'claude-sonnet-5')), {
      KELPIE_GATE_MODE: 'jev',
      KELPIE_GATE_JEV_URL: url,
      CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'test-key',
    })
    const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
    assert.deepEqual(gate.byPath['src/a.ts'].review, { agentType: 'kelpie:verifier', model: 'sonnet', effort: 'xhigh' })
  } finally {
    server.close()
  }
})

test('static mode asks for no review, so B2 stays a known null', async () => {
  const cwd = await workspace(FILES)
  const out = await runGate(auditEvent(cwd), { KELPIE_GATE_MODE: 'static' })
  const gate = JSON.parse(out).hookSpecificOutput.updatedInput.args.gate
  for (const decision of Object.values(gate.byPath)) assert.equal(decision.review, null)
  assert.equal(gate.verify.review, null)
})
