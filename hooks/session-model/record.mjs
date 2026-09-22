#!/usr/bin/env node
// Records the main session's model at SessionStart, so the delegation triage knows it on the first prompt.
//
// Why it exists. No UserPromptSubmit payload names the model, and on a session's first prompt the transcript the
// triage reads it from has no assistant turn yet; on a fresh session the file does not exist at all (measured on
// 2.1.280). The triage then named a route with a condition on a model it could not check. On 2026-09-23 an Opus
// session got "delegate this" above "if this session runs on opus ..., do the work here instead", and spawned three
// general-purpose agents on Opus: the hand-off with no saving behind it. The interactive SessionStart payload does
// carry `model`, so this hook writes it down where session.mjs reads it back.
//
// It writes nothing to stdout, because a SessionStart hook's stdout is added to the session's context. Every failure
// exits 0 and is logged where a log is configured, since a missing record only returns the triage to what it did
// before this hook existed.

import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger, resolveLogPath } from '../log.mjs'
import { RECORD_MAX_AGE_MS, recordFor, tierOf } from '../jev-gate/session.mjs'

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Written to a temporary name and renamed, so a reader never sees half a record. */
const writeRecord = ({ path, body }) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(body)}\n`)
  renameSync(temporary, path)
}

/** Whether a record is stale. A file another session renamed or removed between the listing and the stat is not. */
const isStale = (path, now) => {
  try {
    return now - statSync(path).mtimeMs > RECORD_MAX_AGE_MS
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Returns how many stale records were removed. */
const pruneRecords = ({ dir, now }) => {
  const stale = readdirSync(dir).map((name) => join(dir, name)).filter((path) => isStale(path, now))
  stale.forEach((path) => unlinkSync(path))
  return stale.length
}

const main = async () => {
  const event = JSON.parse(await readStdin())
  const log = logger({ path: resolveLogPath({ env: process.env, cwd: event.cwd ?? '' }).path, base: { hook: 'session-model', session_id: event.session_id ?? null } })
  const now = Date.now()
  const { record, reason } = recordFor({ event, dataDir: process.env.CLAUDE_PLUGIN_DATA, now })
  if (record === null) {
    log({ event: 'skipped', reason })
    return
  }
  writeRecord(record)
  const pruned = pruneRecords({ dir: dirname(record.path), now })
  log({ event: 'recorded', model: record.body.model, tier: tierOf(record.body.model), source: record.body.source, pruned })
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger({ path: resolveLogPath({ env: process.env }).path, base: { hook: 'session-model' } })({
      event: 'error',
      message: String(error && error.message ? error.message : error).slice(0, 500),
    })
    process.exit(0)
  })
