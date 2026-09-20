// The case this module exists for is an exported-but-empty variable, which is how a benchmark arm and a CI job both
// clear a setting for a child process. `??` treats that as configured, and every hook here reads its settings that
// way, so the failures were an effort ceiling of '' that made each clamp throw and a Number('') budget of zero.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { num, str } from '../hooks/env.mjs'

test('empty reaches the default, exactly as absent does', () => {
  assert.equal(str('', 'xhigh'), 'xhigh')
  assert.equal(str('   ', 'xhigh'), 'xhigh')
  assert.equal(str(undefined, 'xhigh'), 'xhigh')
  assert.equal(str(null, 'xhigh'), 'xhigh')
  assert.equal(str('medium', 'xhigh'), 'medium')
  assert.equal(str('  medium  ', 'xhigh'), 'medium', 'a variable set from a heredoc carries whitespace')
})

test('an empty number is the default and not zero, which would be a budget of no milliseconds', () => {
  assert.equal(num('', 6000), 6000)
  assert.equal(num(undefined, 6000), 6000)
  assert.equal(num('0', 6000), 0, 'an explicit zero is a choice and is kept')
  assert.equal(num('3000', 6000), 3000)
  assert.equal(num('0.6', 1), 0.6)
})

test('a value that is not a number falls back rather than becoming NaN', () => {
  assert.equal(num('soon', 6000), 6000)
  assert.equal(num('Infinity', 6000), 6000, 'a budget of forever is a hook that hangs')
})
