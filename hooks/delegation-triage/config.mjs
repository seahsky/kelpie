// Where the triage's on/off switch lives, and which one wins.
//
// It is a file rather than a plugin option or a settings.json hook entry, for two reasons. A plugin option is set
// through the CLI and cannot be written by a skill, and a hook entry in settings.json would have to name the
// plugin's install path, which carries the version in it and so breaks on the next upgrade. A file at a fixed path
// survives upgrades and can be written, read, and deleted by `/kelpie:delegation-triage` with no settings edit.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `signals` emits only on prompts that clear the threshold. `always` emits on every prompt it is allowed to read.
 * `prefer` routes the work to a cheaper subagent where that costs less, instead of arguing for the main thread.
 */
export const MODES = ['off', 'signals', 'always', 'prefer']

/**
 * The mode an install gets when nothing names one: prefer.
 *
 * It was `off`, and the reason no longer holds. Off-by-default assumed the only decision on offer was "delegate or
 * not" at the session's own price, where the main thread won on 180 of 180 measured prompts. prefer mode now
 * delegates only to a model cheaper than the session, and only when the work is big enough to outrun the hand-off,
 * so its answer on most prompts is still "do it here". What it adds is the one case nothing else in kelpie reaches:
 * a job an Opus session would do itself that Sonnet or Haiku can do for less.
 *
 * Without a Jev key it runs on keywords at a bar of one signal, so a prompt with no delegation shape stays silent.
 * With a key, every prompt it reads is sent to a third party, and the key is the consent to that: Claude Code asks
 * for it when the plugin is enabled, and the prompt says what it turns on.
 */
export const DEFAULT_MODE = 'prefer'

export const CONFIG_BASENAME = 'kelpie-triage.json'

/** The parsed config file, or null. A missing, unreadable or malformed file is the same answer: nothing configured. */
const configFile = (path, readImpl = readFileSync) => {
  try {
    const parsed = JSON.parse(readImpl(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The mode a config file names, or null if the file is missing, unreadable, malformed, or names no known mode. */
export const modeInFile = (path, readImpl = readFileSync) => {
  const parsed = configFile(path, readImpl)
  const mode = parsed && typeof parsed.mode === 'string' ? parsed.mode.toLowerCase() : null
  return MODES.includes(mode) ? mode : null
}

/** The log path a config file names, or null. An empty string is "no log", not a path to the working directory. */
export const logInFile = (path, readImpl = readFileSync) => {
  const parsed = configFile(path, readImpl)
  const log = parsed && typeof parsed.log === 'string' ? parsed.log.trim() : ''
  return log === '' ? null : log
}

export const projectConfigPath = (cwd) => join(cwd, '.claude', CONFIG_BASENAME)

export const userConfigPath = ({ env = {}, home = homedir() } = {}) => join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), CONFIG_BASENAME)

/**
 * The mode in force, most specific source first: the environment, then this project, then the user.
 *
 * Project beats user because the case the note is written for is one repo with work too large for one context, not
 * every repo you open. `cwd` comes from the hook payload rather than process.cwd(), since that is the directory
 * Claude Code says the session is in.
 *
 * An unrecognised KELPIE_TRIAGE value falls through to the files instead of raising or disabling. A typo in an
 * environment variable should not silently take a configured project back to off.
 */
/**
 * An explicit score bar from the environment, or null to use the mode's own.
 *
 * It exists for measurement. A run that wants to know what the note does to a session cannot find out on prompts
 * that score zero, and most real prompts score zero: kelpie's own paired A/B ran ten tickets in prefer mode and the
 * note fired on none of them, so the arm measured the plugin's presence and nothing else. `KELPIE_TRIAGE_THRESHOLD=0`
 * makes it fire on every prompt the hook is allowed to read. Out of a measurement harness it is the setting that
 * buys the 6.37x with none of the reason, so it is an environment variable and not a mode.
 */
export const resolveThreshold = ({ env = {} } = {}) => {
  const raw = typeof env.KELPIE_TRIAGE_THRESHOLD === 'string' ? env.KELPIE_TRIAGE_THRESHOLD.trim() : ''
  if (raw === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Whether prefer mode asks Jev about this prompt before deciding, and why not when it does not.
 *
 * It is on by default in prefer mode with a key configured, because that is what prefer mode is for: a keyword score
 * cannot tell whether a job is big enough to hand over, or how cheap a model it can stand.
 *
 * It is prefer mode only. The other modes answer "stay on the main thread" by default and are right on almost every
 * prompt, so paying a network round trip to confirm the default buys nothing. `off` is the way out for anyone in
 * prefer mode who would rather keep every prompt off the wire, which is the one thing this turns on: with it on, the
 * text of every prompt the triage reads is POSTed to a third party before the turn starts.
 */
export const CONSULT_SETTINGS = ['auto', 'off']

export const resolveConsult = ({ env = {}, mode, hasKey = false } = {}) => {
  const setting = typeof env.KELPIE_TRIAGE_CONSULT === 'string' ? env.KELPIE_TRIAGE_CONSULT.trim().toLowerCase() : ''
  // An unrecognised value turns it off, which is the opposite of how resolveMode treats one. The asymmetry is
  // deliberate: a typo in a switch that decides whether prompts leave the machine should leave them here. Somebody
  // who wrote `no` or `false` meant off, and reading that as "on by default" sends their prompts to a third party.
  if (setting !== '' && !CONSULT_SETTINGS.includes(setting)) return { on: false, reason: `KELPIE_TRIAGE_CONSULT=${setting} is not auto or off, so nothing is sent` }
  if (setting === 'off') return { on: false, reason: 'KELPIE_TRIAGE_CONSULT=off' }
  if (mode !== 'prefer') return { on: false, reason: `consulting is prefer mode only, and the mode is ${mode}` }
  if (!hasKey) return { on: false, reason: 'no jev_api_key plugin option' }
  return { on: true, reason: 'prefer mode with a key' }
}

export const resolveMode = ({ env = {}, cwd = '', home = homedir(), modeInFileImpl = modeInFile } = {}) => {
  const fromEnv = typeof env.KELPIE_TRIAGE === 'string' ? env.KELPIE_TRIAGE.trim().toLowerCase() : ''
  if (MODES.includes(fromEnv)) return { mode: fromEnv, source: 'env' }
  if (cwd) {
    const project = modeInFileImpl(projectConfigPath(cwd))
    if (project !== null) return { mode: project, source: projectConfigPath(cwd) }
  }
  const userPath = userConfigPath({ env, home })
  const user = modeInFileImpl(userPath)
  if (user !== null) return { mode: user, source: userPath }
  return { mode: DEFAULT_MODE, source: 'default' }
}
