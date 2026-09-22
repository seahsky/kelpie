// The marketplace entry carries its own copy of the plugin's description, and the plugin listing shows that copy.
// It went stale across 0.2.0 and 0.2.1 because nothing compared the two, so this test does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => JSON.parse(readFileSync(new URL(`../.claude-plugin/${name}`, import.meta.url), 'utf8'))

test('the marketplace entry describes the plugin exactly as plugin.json does', () => {
  const plugin = read('plugin.json')
  const entries = read('marketplace.json').plugins.filter((entry) => entry.name === plugin.name)
  assert.equal(entries.length, 1, `marketplace.json lists ${plugin.name} once`)
  assert.equal(entries[0].description, plugin.description)
})
