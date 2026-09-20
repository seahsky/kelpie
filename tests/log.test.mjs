import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_BASENAME } from '../hooks/delegation-triage/config.mjs'
import { fingerprint, logger, resolveLogPath, resolveVerbosity } from '../hooks/log.mjs'

const configured = async (contents) => {
  const dir = await mkdtemp(join(tmpdir(), 'kelpie-log-'))
  await mkdir(join(dir, '.claude'), { recursive: true })
  if (contents !== null) await writeFile(join(dir, '.claude', CONFIG_BASENAME), contents)
  return dir
}

test('nothing configured means no log, which is what an install that did not ask for one gets', () => {
  assert.equal(resolveLogPath({ env: {}, cwd: '/nonexistent' }).path, null)
})

test('the hook\'s own variable beats the shared one, because configurations already use it', () => {
  const resolved = resolveLogPath({ env: { KELPIE_LOG: '/shared.jsonl' }, override: '/gate.jsonl' })
  assert.deepEqual(resolved, { path: '/gate.jsonl', source: 'env' })
})

test('the shared variable turns both hooks on with one setting', () => {
  assert.equal(resolveLogPath({ env: { KELPIE_LOG: '/shared.jsonl' } }).path, '/shared.jsonl')
})

test('a project config names the log, and beats the user one', async () => {
  const cwd = await configured('{"mode":"signals","log":"/project.jsonl"}')
  assert.equal(resolveLogPath({ env: {}, cwd }).path, '/project.jsonl')
  assert.equal(resolveLogPath({ env: {}, cwd }).source, join(cwd, '.claude', CONFIG_BASENAME))
})

test('an empty or missing log key is no log, not a path to nowhere', async () => {
  const blank = await configured('{"mode":"signals","log":"  "}')
  assert.equal(resolveLogPath({ env: {}, cwd: blank }).path, null)
  const absent = await configured('{"mode":"signals"}')
  assert.equal(resolveLogPath({ env: {}, cwd: absent }).path, null)
  const broken = await configured('not json')
  assert.equal(resolveLogPath({ env: {}, cwd: broken }).path, null)
})

test('CLAUDE_CONFIG_DIR is where the user config is looked for', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'kelpie-log-user-'))
  await writeFile(join(configDir, CONFIG_BASENAME), '{"log":"/user.jsonl"}')
  assert.equal(resolveLogPath({ env: { CLAUDE_CONFIG_DIR: configDir }, cwd: '/nonexistent' }).path, '/user.jsonl')
})

test('prompts and excerpts stay out of the log unless asked for by name', () => {
  assert.deepEqual(resolveVerbosity({ env: {} }), { prompts: false, excerpts: false })
  assert.deepEqual(resolveVerbosity({ env: { KELPIE_LOG_PROMPTS: '1', KELPIE_LOG_EXCERPTS: 'true' } }), { prompts: true, excerpts: true })
  assert.deepEqual(resolveVerbosity({ env: { KELPIE_LOG_PROMPTS: '0', KELPIE_LOG_EXCERPTS: 'no' } }), { prompts: false, excerpts: false })
})

test('a hash identifies a prompt without carrying it', () => {
  assert.equal(fingerprint('a'), fingerprint('a'))
  assert.notEqual(fingerprint('a'), fingerprint('b'))
  assert.match(fingerprint('a'), /^[0-9a-f]{16}$/)
  assert.equal(fingerprint(undefined), null)
})

test('an entry is one line, stamped, with the base fields merged in', () => {
  const written = []
  const log = logger({ path: '/x.jsonl', base: { hook: 'delegation-triage', session_id: 's1' }, appendImpl: (path, line) => written.push([path, line]) })
  log({ event: 'decision', emitted: false })
  assert.equal(written.length, 1)
  assert.equal(written[0][0], '/x.jsonl')
  assert.ok(written[0][1].endsWith('\n'))
  const entry = JSON.parse(written[0][1])
  assert.equal(entry.hook, 'delegation-triage')
  assert.equal(entry.session_id, 's1')
  assert.equal(entry.emitted, false)
  assert.ok(Date.parse(entry.ts) > 0)
})

test('no path means no writes at all, not writes that are thrown away', () => {
  let called = 0
  logger({ path: null, appendImpl: () => { called += 1 } })({ event: 'decision' })
  assert.equal(called, 0)
})

test('a log that cannot be written never reaches the caller', () => {
  // A hook that fails a turn because it could not write its own bookkeeping is worse than a hook with no log.
  const log = logger({ path: '/x.jsonl', appendImpl: () => { throw new Error('read-only file system') } })
  assert.doesNotThrow(() => log({ event: 'decision' }))
})
