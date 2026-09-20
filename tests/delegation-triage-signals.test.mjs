// The prompts below are the point of the module: a keyword list is easy to write and easy to get wrong in the
// direction that costs money, which is firing on ordinary main-thread work. Both directions are pinned here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MANY_ITEMS, MANY_PATHS, PREFER_THRESHOLD, SYNTHETIC_OPENERS, THRESHOLD, countPaths, isSlashCommand, isSynthetic, renderNote, thresholdFor, triage } from '../hooks/delegation-triage/signals.mjs'

const fires = (prompt) => triage(prompt).emit

test('breadth alone is enough, because work too large for one context is the case the roles exist for', () => {
  assert.equal(THRESHOLD, 2)
  assert.ok(fires('add the new licence header to every file in packages/'))
  assert.ok(fires('update the deprecated import across the codebase'))
  assert.ok(fires('bump the peer dependency repo-wide'))
  assert.ok(fires('drop the unused export from src/**/*.ts'))
})

test('a written-out list of paths is the caller naming a fan-out already', () => {
  assert.equal(MANY_PATHS, 3)
  assert.ok(fires('tighten the types in src/a.ts, src/b.ts and src/c.ts'))
  assert.ok(!fires('tighten the types in src/a.ts and src/b.ts'), 'two files is an afternoon on the main thread')
})

test('a path is a path however deep it is', () => {
  // The detector held one slash, so every path deeper than `src/a.ts` counted as no path at all and the prompt most
  // likely to be a real fan-out, one that writes out three files in a monorepo, scored zero.
  assert.equal(countPaths('tighten the types in src/api/handlers/a.ts, src/api/handlers/b.ts and packages/core/src/c.tsx'), 3)
  assert.ok(fires('tighten the types in src/api/handlers/a.ts, src/api/handlers/b.ts and packages/core/src/c.tsx'))
  assert.equal(countPaths('and/or is not a path, nor is 3.5'), 0)
  assert.equal(countPaths(null), 0)
})

test('a count only counts when it is large enough to be breadth', () => {
  assert.equal(MANY_ITEMS, 5)
  assert.ok(fires('apply the same fix to 40 files'))
  assert.ok(!fires('apply the fix to 2 files'))
})

test('a weak signal on its own does not fire, because it names work a main thread does more cheaply', () => {
  assert.ok(!fires('review this function'), 'a review of one function is not a verifier spawn')
  assert.ok(!fires('audit the login form'))
  assert.ok(!fires('find the bug in src/auth.ts'))
  assert.ok(!fires('rename this variable'))
  assert.ok(!fires('what does this regex do?'))
  assert.ok(!fires('run the tests'))
})

test('breadth after an execution verb is an argument to one command, not a fan-out', () => {
  assert.ok(!fires('run all the tests'))
  assert.ok(!fires('rerun every test that failed'))
  assert.ok(!fires('build all the packages'))
  assert.ok(fires('update all the tests to the new helper'), 'the same breadth under an edit verb still fires')
  assert.ok(fires('run the codemod across every service'), 'the verb is not the whole rule')
})

test('two weak signals together do fire', () => {
  const result = triage('review the new handlers and verify every route still authenticates')
  assert.ok(result.emit)
  assert.ok(result.score >= THRESHOLD)
})

test('a slash command is quiet, since it carries its own instructions', () => {
  assert.ok(isSlashCommand('/kelpie:migrate-in-parallel'))
  assert.deepEqual(triage('/kelpie:migrate-in-parallel src/**/*.ts'), { quiet: true, fired: [], score: 0, emit: false })
})

test('an empty or non-string prompt is quiet rather than an exception', () => {
  assert.equal(triage('').quiet, true)
  assert.equal(triage('   ').quiet, true)
  assert.equal(triage(undefined).quiet, true)
  assert.equal(triage(null).quiet, true)
  assert.equal(triage(42).quiet, true)
})

test('the note names what fired and leads with the main thread, not with a spawn', () => {
  const result = triage('port the old client to the new one across every service')
  const note = renderNote(result)
  assert.match(note, /kelpie delegation triage: this prompt carries breadth/)
  const bullets = note.split('\n').filter((line) => line.startsWith('- '))
  assert.match(bullets[0], /main thread/, 'the answer on almost every prompt is first for that reason')
  assert.match(note, /6\.37x/)
  assert.match(note, /kelpie:mech-executor/)
  assert.match(note, /kelpie:verifier/)
})

test('prefer mode lowers the bar to one signal, but zero is still zero', () => {
  assert.equal(PREFER_THRESHOLD, 1)
  assert.equal(thresholdFor('prefer'), 1)
  assert.equal(thresholdFor('signals'), THRESHOLD)
  assert.equal(triage('review this function').score, 1, 'one signal, below the default bar and on the prefer bar')
  assert.equal(triage('fix the typo on line 40').score, 0, 'nothing to fan out, so prefer mode has nothing to say')
})

test('the prefer note routes the work instead of arguing for the main thread', () => {
  const result = triage('review this function')
  const note = renderNote({ ...result, mode: 'prefer' })
  assert.match(note, /prefer mode/)
  assert.match(note, /opted into delegating by default/)
  assert.match(note, /6\.37x/, 'the cost is stated even in the mode that accepts it')
  assert.match(note, /\/kelpie:migrate-in-parallel/)
  assert.match(note, /open design decisions left in it, and security-sensitive work/, 'the two exclusions survive the inversion')
  assert.doesNotMatch(note, /Do it on the main thread/)
})

test('the default note is unchanged by the mode that inverts it', () => {
  const result = triage('port the old client across every service')
  assert.equal(renderNote(result), renderNote({ ...result, mode: 'signals' }))
  assert.match(renderNote({ ...result, mode: 'always' }), /Do it on the main thread/)
})

test('the no-signal note is one line, because always mode pays for it on every turn', () => {
  const note = renderNote({ fired: [] })
  assert.equal(note.split('\n').length, 1)
  assert.match(note, /main thread is the default/)
})

// The shape Claude Code enqueues when a Bash call with run_in_background finishes, so it arrives at the hook
// indistinguishable from something the user typed. On one run of kelpie's own benchmark, twelve of the thirteen
// prompts the triage saw were these, and it answered every one with a full delegation policy. The body carries a
// breadth phrase on purpose: that is what used to score it and make the note fire.
const TASK_NOTIFICATION = '<task-notification>\n<task-id>bp764e8lk</task-id>\n<output-file>/private/tmp/out.txt</output-file>\nBackground task completed: build every package\n</task-notification>'

test('a background task finishing is not a prompt, whatever it looks like', () => {
  const result = triage(TASK_NOTIFICATION)
  assert.equal(result.quiet, true, 'a shell job completion notice is not a delegation decision point')
  assert.equal(result.emit, false)
})

test('the notice is quiet even though its text would otherwise score', () => {
  // "across every package" carries breadth. Scoring it would be scoring Claude Code's own wording, not the user's.
  assert.ok(triage('rebuild admin-portal across every package').score > 0, 'the wording does score on its own')
  assert.equal(triage(TASK_NOTIFICATION).score, 0)
})

test('every wrapper Claude Code submits itself is quiet', () => {
  for (const opener of SYNTHETIC_OPENERS) {
    assert.equal(isSynthetic(`<${opener}>body</${opener}>`), true, `<${opener}> should be quiet`)
    assert.equal(triage(`<${opener}>\nmigrate every handler across the codebase\n</${opener}>`).quiet, true, `<${opener}> should be quiet`)
  }
})

test('markup a user wrote is still read, because the list is enumerated and not a general tag match', () => {
  assert.equal(isSynthetic('<div> needs the same change in every component'), false)
  assert.equal(isSynthetic('<TaskNotification /> is the component to rename everywhere'), false)
  assert.ok(triage('<div> needs the same change in every component').score > 0, 'a user opening with markup still gets triaged')
})

test('a wrapper name has to be the whole tag, not a prefix of one', () => {
  assert.equal(isSynthetic('<task-notifications-are-broken> fix them across the repo'), false)
})

test('always mode with nothing fired still gets the one-liner, not the routes', () => {
  assert.match(renderNote({ fired: [], mode: 'always' }), /main thread is the default/)
})

test('prefer mode with nothing fired routes, and says the bar is why', () => {
  // The paired A/B ran ten tickets in prefer mode and fired on none of them, because a prompt can be real work and
  // still score zero. With the bar lowered on purpose, the routes are what the run is paying to measure.
  const note = renderNote({ fired: [], mode: 'prefer' })
  assert.match(note, /set the bar to route it anyway/)
  assert.match(note, /kelpie:mech-executor/)
  assert.doesNotMatch(note, /main thread is the default/)
})
