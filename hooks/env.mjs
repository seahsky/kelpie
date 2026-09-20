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

export const num = (value, fallback) => {
  const text = str(value, '')
  if (text === '') return fallback
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : fallback
}
