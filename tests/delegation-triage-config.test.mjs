import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_BASENAME, MODES, modeInFile, resolveMode, resolveThreshold, userConfigPath } from '../hooks/delegation-triage/config.mjs'

const configured = async (prefix, contents) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(dir, '.claude'), { recursive: true })
  if (contents !== null) await writeFile(join(dir, '.claude', CONFIG_BASENAME), contents)
  return dir
}

test('an install that has never run the skill is off', () => {
  assert.deepEqual(resolveMode({ env: {}, cwd: '/nonexistent', home: '/nonexistent' }), { mode: 'off', source: 'default' })
})

test('a missing, unreadable, or malformed file is null rather than a guessed mode', () => {
  assert.equal(modeInFile('/nonexistent/kelpie-triage.json'), null)
  assert.equal(modeInFile('x', () => 'not json'), null)
  assert.equal(modeInFile('x', () => '{"mode":"loud"}'), null, 'an unknown mode is not a mode')
  assert.equal(modeInFile('x', () => '{}'), null)
  assert.equal(modeInFile('x', () => 'null'), null)
})

test('every shipped mode round-trips out of a file, case-insensitively', () => {
  assert.deepEqual(MODES, ['off', 'signals', 'always', 'prefer'])
  for (const mode of MODES) assert.equal(modeInFile('x', () => JSON.stringify({ mode: mode.toUpperCase() })), mode)
})

test('the project file wins over the user file, because the work is one repo and not every repo', async () => {
  const cwd = await configured('kelpie-triage-project-', '{"mode":"always"}')
  const home = await configured('kelpie-triage-home-', null)
  await writeFile(userConfigPath({ env: {}, home }), '{"mode":"signals"}')
  assert.deepEqual(resolveMode({ env: {}, cwd, home }), { mode: 'always', source: join(cwd, '.claude', CONFIG_BASENAME) })
})

test('a project can be turned off while the user file stays on', async () => {
  const cwd = await configured('kelpie-triage-project-', '{"mode":"off"}')
  const home = await configured('kelpie-triage-home-', null)
  await writeFile(userConfigPath({ env: {}, home }), '{"mode":"signals"}')
  assert.equal(resolveMode({ env: {}, cwd, home }).mode, 'off')
})

test('CLAUDE_CONFIG_DIR is where the user file lives when it is set', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'kelpie-triage-config-'))
  await writeFile(join(configDir, CONFIG_BASENAME), '{"mode":"signals"}')
  assert.equal(resolveMode({ env: { CLAUDE_CONFIG_DIR: configDir }, cwd: '/nonexistent', home: '/nonexistent' }).mode, 'signals')
})

test('the environment beats both files', async () => {
  const cwd = await configured('kelpie-triage-project-', '{"mode":"signals"}')
  assert.deepEqual(resolveMode({ env: { KELPIE_TRIAGE: 'OFF' }, cwd, home: '/nonexistent' }), { mode: 'off', source: 'env' })
})

test('a typo in the variable falls through to the files rather than silently disabling a configured project', async () => {
  const cwd = await configured('kelpie-triage-project-', '{"mode":"signals"}')
  assert.equal(resolveMode({ env: { KELPIE_TRIAGE: 'sginals' }, cwd, home: '/nonexistent' }).mode, 'signals')
})

test('no threshold variable means the mode keeps its own bar', () => {
  assert.equal(resolveThreshold({ env: {} }), null)
  assert.equal(resolveThreshold({ env: { KELPIE_TRIAGE_THRESHOLD: '  ' } }), null)
})

test('zero is a threshold, not an absent one, because zero is the whole point of the variable', () => {
  assert.equal(resolveThreshold({ env: { KELPIE_TRIAGE_THRESHOLD: '0' } }), 0)
  assert.equal(resolveThreshold({ env: { KELPIE_TRIAGE_THRESHOLD: '2' } }), 2)
})

test('a value that is not a whole number falls back to the mode rather than to an accidental bar', () => {
  for (const raw of ['x', '1.5', '-1', '']) {
    assert.equal(resolveThreshold({ env: { KELPIE_TRIAGE_THRESHOLD: raw } }), null, `${raw} should not set a bar`)
  }
})
