// Runs hooks/session-model/record.mjs the way Claude Code does: a SessionStart payload on stdin, and the plugin data
// directory in CLAUDE_PLUGIN_DATA. The payloads below use the fields an interactive 2.1.280 SessionStart payload
// carried when measured: session_id, transcript_path, cwd, hook_event_name, source, and model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECORD_MAX_AGE_MS, readRecordedModel, recordFor, recordedModelPath } from '../hooks/jev-gate/session.mjs'

const HOOK = new URL('../hooks/session-model/record.mjs', import.meta.url).pathname

const runHook = (event, env = {}) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [HOOK], { env: { ...process.env, KELPIE_LOG: '', ...env } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}`))
    else resolve(stdout)
  })
  child.stdin.end(JSON.stringify(event))
})

const startup = (overrides = {}) => ({
  session_id: 'a0c86ed7-1e3d-4ac6-8f00-000000000001',
  transcript_path: '/nonexistent/transcript.jsonl',
  cwd: '/tmp',
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-5-5[1m]',
  ...overrides,
})

test('the model a SessionStart payload names is what the triage reads back on the first prompt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  const event = startup()
  const stdout = await runHook(event, { CLAUDE_PLUGIN_DATA: dataDir })
  assert.equal(stdout, '', 'SessionStart stdout is added to the session context, so the hook prints nothing')
  const path = recordedModelPath({ dataDir, sessionId: event.session_id })
  assert.equal(readRecordedModel(path), 'opus')
  const body = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(body.model, 'claude-opus-5-5[1m]')
  assert.equal(body.source, 'startup')
})

test('a resumed session overwrites its record, so the latest SessionStart wins', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  await runHook(startup(), { CLAUDE_PLUGIN_DATA: dataDir })
  await runHook(startup({ source: 'resume', model: 'claude-sonnet-5' }), { CLAUDE_PLUGIN_DATA: dataDir })
  assert.equal(readRecordedModel(recordedModelPath({ dataDir, sessionId: startup().session_id })), 'sonnet')
})

test('a resume names no model and can change it, so the session\'s earlier record is removed', async () => {
  // Measured on 2.1.280: `--resume <id> --model sonnet` keeps the session id and sends `model: null`.
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  const path = recordedModelPath({ dataDir, sessionId: startup().session_id })
  await runHook(startup(), { CLAUDE_PLUGIN_DATA: dataDir })
  assert.equal(readRecordedModel(path), 'opus')
  assert.equal(await runHook(startup({ source: 'resume', model: null }), { CLAUDE_PLUGIN_DATA: dataDir }), '')
  assert.equal(readRecordedModel(path), null, 'the opus record from before the resume is not read')
})

test('a resume with no record to remove exits cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  assert.equal(await runHook(startup({ source: 'resume', model: null }), { CLAUDE_PLUGIN_DATA: dataDir }), '')
  assert.deepEqual(await readdir(dataDir), [])
})

test('a headless SessionStart names no model, and nothing is written for it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  const { model, ...headless } = startup()
  assert.equal(await runHook(headless, { CLAUDE_PLUGIN_DATA: dataDir }), '')
  assert.deepEqual(await readdir(dataDir), [])
})

test('with no plugin data directory the hook writes nothing and still exits cleanly', async () => {
  assert.equal(await runHook(startup(), { CLAUDE_PLUGIN_DATA: '' }), '')
})

test('records older than a week are pruned, and fresh ones are kept', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kelpie-plugin-data-'))
  const sessions = join(dataDir, 'sessions')
  await mkdir(sessions, { recursive: true })
  const stale = join(sessions, 'stale.json')
  const fresh = join(sessions, 'fresh.json')
  await writeFile(stale, '{"model":"claude-opus-5"}')
  await writeFile(fresh, '{"model":"claude-opus-5"}')
  const old = new Date(Date.now() - RECORD_MAX_AGE_MS - 60000)
  await utimes(stale, old, old)
  await runHook(startup(), { CLAUDE_PLUGIN_DATA: dataDir })
  assert.deepEqual((await readdir(sessions)).sort(), [`${startup().session_id}.json`, 'fresh.json'])
})

test('recordFor says why it wrote nothing', () => {
  const now = Date.parse('2026-09-23T00:00:00Z')
  assert.match(recordFor({ event: startup({ hook_event_name: 'UserPromptSubmit' }), dataDir: '/d', now }).reason, /not a SessionStart/)
  assert.match(recordFor({ event: startup({ session_id: '../x' }), dataDir: '/d', now }).reason, /no usable session id/)
  const unnamed = recordFor({ event: startup({ source: 'clear', model: null }), dataDir: '/d', now })
  assert.match(unnamed.reason, /names no tier/)
  assert.equal(unnamed.record, null)
  assert.equal(unnamed.forget, recordedModelPath({ dataDir: '/d', sessionId: startup().session_id }))
  assert.equal(recordFor({ event: startup({ session_id: '../x', model: null }), dataDir: '/d', now }).forget, null, 'no usable id, nothing to remove')
  const { record, forget } = recordFor({ event: startup(), dataDir: '/d', now })
  assert.equal(forget, null)
  assert.deepEqual(record.body, { model: 'claude-opus-5-5[1m]', source: 'startup', recorded_at: '2026-09-23T00:00:00.000Z' })
})
