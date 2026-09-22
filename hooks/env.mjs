// Reading a setting out of the environment, where empty means unset.
//
// `env.X ?? fallback` looks right and is not: `??` only steps aside for null and undefined, so an exported-but-empty
// variable reads as a configured value. That is the shape a benchmark arm and a CI job both produce, because the way
// to clear a variable for a child process is to set it to ''. The results were an effort ceiling of '', which makes
// every clamp throw, a request URL of '', which makes every call fail, and `Number('')`, which is 0: a budget of no
// milliseconds and a concurrency of no workers.
//
// So emptiness reaches the default here, exactly as absence does.

export const str = (value, fallback) => {
  const text = String(value ?? '').trim()
  return text === '' ? fallback : text
}

/**
 * A boolean plugin option, which is on only when it says `true`.
 *
 * Measured on Claude Code 2.1.278: a boolean option set to true reaches a hook as the string `true`, and one left at
 * its default or never set is not exported at all. `1` is accepted for a harness that sets the variable by hand.
 * Anything else is off, because the switch this reads decides whether prompts leave the machine.
 */
export const flag = (value) => ['true', '1'].includes(str(value, '').toLowerCase())

export const num = (value, fallback) => {
  const text = str(value, '')
  if (text === '') return fallback
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : fallback
}
