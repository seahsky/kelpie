// Runs hooks/delegation-triage/triage.mjs the way Claude Code runs it: as a subprocess fed one UserPromptSubmit
// event on stdin. What matters here is that an unconfigured install emits nothing, and that no input shape can make
// the hook fail a turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = new URL('../hooks/delegation-triage/triage.mjs', import.meta.url).pathname

// Every variable the hook reads, cleared before the caller's own. The key matters most: with one exported in the
// shell, which is exactly what running kelpie's benchmark does, the prefer-mode tests below would have sent their
// prompts to the real API and billed for them. Tests that need a key set one explicitly and point it at a stub.
const CLEARED = {
  KELPIE_TRIAGE: '',
  KELPIE_TRIAGE_THRESHOLD: '',
  KELPIE_TRIAGE_CONSULT: 'off',
  CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '',
  KELPIE_LOG: '',
  KELPIE_LOG_PROMPTS: '',
}

const runHook = (event, env = {}, stdin = null) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [HOOK], { env: { ...process.env, ...CLEARED, ...env } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}`))
    else resolve(stdout.trim())
  })
  child.stdin.end(stdin === null ? JSON.stringify(event) : stdin)
})

const project = async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'kelpie-triage-hook-'))
  if (mode !== null) {
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude', 'kelpie-triage.json'), JSON.stringify({ mode }))
  }
  return dir
}

const event = (cwd, prompt) => ({
  session_id: 'test-session',
  cwd,
  hook_event_name: 'UserPromptSubmit',
  prompt,
})

const BROAD = 'move every handler in src/api onto the new client'

test('an install that has not been turned on emits nothing, whatever the prompt looks like', async () => {
  const cwd = await project(null)
  assert.equal(await runHook(event(cwd, BROAD)), '')
})

test('signals mode emits on a delegation-shaped prompt, as additionalContext and nothing else', async () => {
  const cwd = await project('signals')
  const output = JSON.parse(await runHook(event(cwd, BROAD)))
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput'])
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(output.hookSpecificOutput.additionalContext, /kelpie delegation triage/)
  assert.equal(output.hookSpecificOutput.updatedInput, undefined, 'a triage never rewrites what the user typed')
})

test('signals mode stays silent on ordinary work', async () => {
  const cwd = await project('signals')
  assert.equal(await runHook(event(cwd, 'fix the off-by-one in src/paginate.ts')), '')
})

test('always mode says one line on the prompts signals mode skips', async () => {
  const cwd = await project('always')
  const output = JSON.parse(await runHook(event(cwd, 'fix the off-by-one in src/paginate.ts')))
  assert.match(output.hookSpecificOutput.additionalContext, /no delegation-shaped signal/)
})

test('prefer mode speaks where signals mode stays silent, and routes rather than argues', async () => {
  const cwd = await project('prefer')
  const output = JSON.parse(await runHook(event(cwd, 'review the new session handler')))
  const note = output.hookSpecificOutput.additionalContext
  assert.match(note, /prefer mode/)
  assert.match(note, /kelpie:mech-executor/)
  assert.equal(await runHook({ ...event(cwd, 'review the new session handler'), cwd: await project('signals') }), '')
})

test('prefer mode is still silent on a prompt with nothing to fan out', async () => {
  const cwd = await project('prefer')
  assert.equal(await runHook(event(cwd, 'fix the typo on line 40')), '')
})

// The prompt template kelpie's own paired benchmark runs, with its ticket number and branch replaced. Ten tickets
// went through it in prefer mode and the note fired on none of them, because it scores zero: no breadth, no repeated
// treatment, no check verb, no recon phrasing. That run measured the plugin's presence and not the triage, so the
// shape is pinned here: an ordinary "implement this issue" prompt is the case the signal families cannot see.
const MEASURED = 'GitHub issue #1234 in this repository is your task. Read the issue, study the code it concerns, implement it, and open a pull request.\n\nYou are already on branch ab/1234/A, created from the base commit. Commit your work there, push it, and open the PR against the main branch. Do not switch branches, and do not work on any other issue.'

test('the prompt the paired A/B actually ran scores zero, so prefer mode says nothing on it', async () => {
  const cwd = await project('prefer')
  assert.equal(await runHook(event(cwd, MEASURED)), '')
})

test('the threshold variable is what makes that prompt fire, and it routes when it does', async () => {
  const cwd = await project('prefer')
  const output = JSON.parse(await runHook(event(cwd, MEASURED), { KELPIE_TRIAGE_THRESHOLD: '0' }))
  const note = output.hookSpecificOutput.additionalContext
  assert.match(note, /prefer mode/)
  assert.match(note, /kelpie:mech-executor/)
})

test('a lowered bar does not make the hook read prompts it has no business reading', async () => {
  const cwd = await project('prefer')
  assert.equal(await runHook(event(cwd, '/kelpie:audit-many-files'), { KELPIE_TRIAGE_THRESHOLD: '0' }), '')
  assert.equal(await runHook(event(cwd, '   '), { KELPIE_TRIAGE_THRESHOLD: '0' }), '')
})

test('the threshold cannot turn a triage on that is off', async () => {
  const cwd = await project(null)
  assert.equal(await runHook(event(cwd, BROAD), { KELPIE_TRIAGE_THRESHOLD: '0' }), '')
})

// The decision log. The paired A/B ran ten tickets in prefer mode, fired on none of them, and recorded nothing,
// so the arm read as a measurement of the triage while measuring the plugin's presence. Silence is logged here for
// that reason: a log that only records the times a hook acted hides the case that went wrong.
const decisions = async (log) => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))

test('a prompt that got nothing is logged, with the reason it got nothing', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  assert.equal(await runHook(event(cwd, MEASURED), { KELPIE_LOG: log }), '')
  const [entry] = await decisions(log)
  assert.equal(entry.hook, 'delegation-triage')
  assert.equal(entry.event, 'decision')
  assert.equal(entry.emitted, false)
  assert.equal(entry.mode, 'prefer')
  assert.equal(entry.score, 0)
  assert.deepEqual(entry.fired, [])
  assert.equal(entry.bar, 1)
  assert.match(entry.reason, /score 0 is under the bar of 1/)
  assert.equal(entry.session_id, 'test-session')
  assert.equal(entry.cwd, cwd)
})

test('a prompt that got the note is logged with what fired and how long the note was', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, BROAD), { KELPIE_LOG: log })
  const [entry] = await decisions(log)
  assert.equal(entry.emitted, true)
  assert.deepEqual(entry.fired, ['breadth'])
  assert.ok(entry.note_chars > 0)
  assert.match(entry.reason, /clears the bar/)
})

test('the triage being off is logged too, because off is a configuration state and not an absence of one', async () => {
  const cwd = await project(null)
  const log = join(cwd, 'kelpie.jsonl')
  assert.equal(await runHook(event(cwd, BROAD), { KELPIE_LOG: log }), '')
  const [entry] = await decisions(log)
  assert.equal(entry.mode, 'off')
  assert.equal(entry.mode_source, 'default')
  assert.equal(entry.emitted, false)
  assert.match(entry.reason, /triage is off/)
})

test('the log carries the prompt\'s shape, never the prompt, unless it is asked for by name', async () => {
  const cwd = await project('signals')
  const quiet = join(cwd, 'quiet.jsonl')
  await runHook(event(cwd, BROAD), { KELPIE_LOG: quiet })
  const [held] = await decisions(quiet)
  assert.equal(held.prompt, undefined, 'a prompt carries whatever the user typed into it')
  assert.equal(held.prompt_chars, BROAD.length)
  assert.match(held.prompt_sha256, /^[0-9a-f]{16}$/)

  const verbose = join(cwd, 'verbose.jsonl')
  await runHook(event(cwd, BROAD), { KELPIE_LOG: verbose, KELPIE_LOG_PROMPTS: '1' })
  const [shown] = await decisions(verbose)
  assert.equal(shown.prompt, BROAD)
})

test('an explicit bar is recorded as an override, not as the mode\'s own bar', async () => {
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, MEASURED), { KELPIE_LOG: log, KELPIE_TRIAGE_THRESHOLD: '0' })
  const [entry] = await decisions(log)
  assert.equal(entry.threshold_override, 0)
  assert.equal(entry.bar, 0)
  assert.equal(entry.emitted, true)
})

test('a slash command is logged as read and skipped, which is not the same as scoring zero', async () => {
  const cwd = await project('always')
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, '/kelpie:audit-many-files'), { KELPIE_LOG: log })
  const [entry] = await decisions(log)
  assert.equal(entry.emitted, false)
  assert.match(entry.reason, /a slash command, or a notice Claude Code generated/)
})

test('a background task notification is logged as read and skipped, not answered with a policy', async () => {
  // Measured on one run of kelpie's own benchmark: 12 of the 13 prompts the triage saw were these, and it emitted a
  // full note for every one. The log is where that shows up now, and quiet is where it belongs.
  const cwd = await project('prefer')
  const log = join(cwd, 'kelpie.jsonl')
  const notification = '<task-notification>\n<task-id>bp764e8lk</task-id>\nBackground task completed: build across every package\n</task-notification>'
  assert.equal(await runHook(event(cwd, notification), { KELPIE_LOG: log, KELPIE_TRIAGE_THRESHOLD: '0' }), '', 'not even a lowered bar reaches it')
  const [entry] = await decisions(log)
  assert.equal(entry.emitted, false)
  assert.equal(entry.score, 0)
  assert.match(entry.reason, /a notice Claude Code generated/)
})

test('a log that cannot be written does not fail the turn', async () => {
  const cwd = await project('signals')
  const output = await runHook(event(cwd, BROAD), { KELPIE_LOG: '/nonexistent-directory/kelpie.jsonl' })
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /kelpie delegation triage/)
})

test('one line per prompt, appended, so a session reads in order', async () => {
  const cwd = await project('signals')
  const log = join(cwd, 'kelpie.jsonl')
  await runHook(event(cwd, BROAD), { KELPIE_LOG: log })
  await runHook(event(cwd, 'fix the typo on line 40'), { KELPIE_LOG: log })
  const entries = await decisions(log)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.emitted), [true, false])
})

test('always mode is still quiet on a slash command', async () => {
  const cwd = await project('always')
  assert.equal(await runHook(event(cwd, '/kelpie:audit-many-files')), '')
})

test('the environment variable turns it on without a file, for a benchmark arm', async () => {
  const cwd = await project(null)
  const output = JSON.parse(await runHook(event(cwd, BROAD), { KELPIE_TRIAGE: 'signals' }))
  assert.match(output.hookSpecificOutput.additionalContext, /kelpie delegation triage/)
})

test('a payload for another event is not read, even with the triage on', async () => {
  const cwd = await project('always')
  assert.equal(await runHook({ ...event(cwd, BROAD), hook_event_name: 'PreToolUse' }), '')
})

test('no input shape can fail a turn: broken stdin exits 0 and emits nothing', async () => {
  const cwd = await project('always')
  assert.equal(await runHook(null, {}, 'not json at all'), '')
  assert.equal(await runHook(null, {}, ''), '')
  assert.equal(await runHook({ hook_event_name: 'UserPromptSubmit' }), '', 'no cwd, no prompt')
  assert.equal(await runHook({ hook_event_name: 'UserPromptSubmit', cwd, prompt: { not: 'a string' } }), '')
})
