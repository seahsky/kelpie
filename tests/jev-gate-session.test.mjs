// The entries below use the field names a real transcript uses, checked against a live 2.1.278 session transcript:
// each assistant line carries `type`, `isSidechain`, and `message.model`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_TIERS, readTail, resolveSession, sessionModelFromTranscript, tierOf } from '../hooks/jev-gate/session.mjs'

const assistant = (model, { sidechain = false } = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: sidechain, message: { role: 'assistant', model, content: [] } })

const user = () => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' } })

test('a session can run on fable even though the gate cannot route to it', () => {
  assert.deepEqual(MODEL_TIERS, ['haiku', 'sonnet', 'opus', 'fable'])
})

test('every model id spelling a session actually writes maps to its tier', () => {
  assert.equal(tierOf('claude-opus-5'), 'opus')
  assert.equal(tierOf('opus[1m]'), 'opus')
  assert.equal(tierOf('claude-sonnet-5'), 'sonnet')
  assert.equal(tierOf('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(tierOf('claude-fable-5-1'), 'fable')
})

test('a model id naming no tier is null rather than a guess', () => {
  assert.equal(tierOf('some-other-model'), null)
  assert.equal(tierOf(undefined), null)
  assert.equal(tierOf(null), null)
})

test('the tier comes from the last main-thread assistant turn', () => {
  const text = [assistant('claude-sonnet-5'), user(), assistant('claude-opus-5'), user()].join('\n')
  assert.equal(sessionModelFromTranscript(text), 'opus')
})

test('a subagent turn is not the session, so sidechain entries are skipped', () => {
  const text = [assistant('claude-opus-5'), assistant('claude-haiku-4-5', { sidechain: true })].join('\n')
  assert.equal(sessionModelFromTranscript(text), 'opus', 'the haiku line is a spawn, which is what the gate is deciding')
})

test('a truncated or half-written line is skipped, because reading a tail produces one by construction', () => {
  const text = ['ssage":{"role":"assistant","model":"claude-fable-5-1"}}', assistant('claude-opus-5'), '{"type":"assistant","isSid'].join('\n')
  assert.equal(sessionModelFromTranscript(text), 'opus')
})

test('a transcript with no assistant turn yet resolves to null, not to a default', () => {
  assert.equal(sessionModelFromTranscript([user(), user()].join('\n')), null)
  assert.equal(sessionModelFromTranscript(''), null)
})

test('an unreadable transcript is empty rather than an exception, because no gate failure may reach the session', () => {
  assert.equal(readTail('/nonexistent/transcript.jsonl'), '')
  assert.equal(resolveSession({ transcriptPath: '/nonexistent/transcript.jsonl' }).model, null)
  assert.equal(resolveSession({ transcriptPath: '' }).model, null)
})

test('the tail is read from the end, so a long transcript costs a fixed read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kelpie-session-'))
  const path = join(dir, 'transcript.jsonl')
  const filler = Array.from({ length: 4000 }, () => assistant('claude-sonnet-5')).join('\n')
  await writeFile(path, `${filler}\n${assistant('claude-opus-5')}\n`)
  const tail = readTail(path, 4096)
  assert.ok(tail.length <= 4096)
  assert.equal(sessionModelFromTranscript(tail), 'opus', 'the newest turn is the one that survives the tail')
})

test('effort comes from the payload, and falls back to the env var Claude Code also exports', () => {
  assert.equal(resolveSession({ transcriptPath: '', effortLevel: 'xhigh' }).effort, 'xhigh')
  assert.equal(resolveSession({ transcriptPath: '', env: { CLAUDE_EFFORT: 'high' } }).effort, 'high')
  assert.equal(resolveSession({ transcriptPath: '', effortLevel: 'low', env: { CLAUDE_EFFORT: 'high' } }).effort, 'low')
  // Absent on a model with no effort support, which the docs state plainly, so null is a real answer here.
  assert.equal(resolveSession({ transcriptPath: '' }).effort, null)
})
