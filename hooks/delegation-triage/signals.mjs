// Which delegation-shaped signals a prompt carries, and the note handed back when enough of them fire.
//
// Kept pure and out of the hook so the decision reads as text in, verdict out, and so the one place that decides
// whether a prompt is worth a paragraph of injected context fits on a screen.
//
// The weights are kelpie's measured policy, not a guess about language. Breadth is the only family that clears the
// bar on its own, because breadth is the one shape the benchmark left open: every trial it scored fit inside one
// context, and work that does not fit one context is the case the two surviving roles exist for. Every other family
// has to co-occur with something, because alone it names work the main thread does more cheaply. "Review this
// function" is a review, and forcing that through a subagent measured 6.37x the cost of a plain prompt for the same
// 100% pass rate.

/** A prompt opening with a slash is a command carrying its own instructions, kelpie's own workflows included. */
export const isSlashCommand = (text) => /^\s*\//.test(text)

/**
 * Wrappers Claude Code generates and submits through UserPromptSubmit itself.
 *
 * These reach the hook looking exactly like something the user typed. A background shell finishing is the common
 * one: every `Bash` call with `run_in_background` ends by enqueuing a `<task-notification>` as a prompt. Measured
 * on one run of kelpie's own A/B, 12 of the 13 prompts the triage saw were these, so twelve of its thirteen notes
 * were a delegation policy injected into a shell job completion notice. That is about 3.2k tokens of waste, and
 * worse for the measurement, the waste scales with how many background tasks an arm happens to launch rather than
 * with anything the arm is supposed to be testing.
 *
 * The list is enumerated rather than a general `^<tag>` match, because a prompt genuinely can open with markup a
 * user wrote. An unrecognised wrapper falls through and gets scored, which is the behaviour before this existed.
 */
export const SYNTHETIC_OPENERS = [
  'task-notification',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
]
const SYNTHETIC = new RegExp(`^\\s*<(?:${SYNTHETIC_OPENERS.join('|')})(?:[\\s>]|/>)`, 'i')

export const isSynthetic = (text) => SYNTHETIC.test(text)

const matches = (pattern) => (text) => pattern.test(text)

/** Three or more paths written out is the caller already naming a fan-out, whatever words surround them. */
export const MANY_PATHS = 3
// The repeated group is what makes `src/api/handlers/a.ts` a path. With one `/` in the pattern it matched `src/a.ts`
// and nothing deeper, so three real paths in a monorepo prompt counted as zero and the breadth family never fired.
const PATH_LIKE = /(?:^|[\s"'`([,])[\w@.-]*(?:\/[\w.-]+)+\.[a-zA-Z0-9]+/g

/** Exported because the prompt-level Jev request carries this count in state: Jev is documented not to count reliably. */
export const countPaths = (text) => (typeof text === 'string' ? (text.match(PATH_LIKE) ?? []).length : 0)

const namesManyPaths = (text) => countPaths(text) >= MANY_PATHS

/** "12 files" is breadth. "2 files" is an afternoon on the main thread. */
export const MANY_ITEMS = 5
const COUNTED_ITEMS = /\b(\d+)\s+(?:more\s+)?(?:files|modules|tests|components|packages|services|handlers|routes|endpoints|call ?sites|usages|occurrences)\b/gi
const countsManyItems = (text) => {
  for (const match of text.matchAll(COUNTED_ITEMS)) {
    if (Number(match[1]) >= MANY_ITEMS) return true
  }
  return false
}

export const FAMILIES = [
  {
    name: 'breadth',
    weight: 2,
    detectors: [
      // The lookbehind is the difference between "update all the tests" and "run all the tests". After an execution
      // verb, breadth is an argument to one command, not a count of things to work through one at a time.
      matches(/(?<!\b(?:run|rerun|re-run|execute|start|launch|build|rebuild)\s+)\b(?:every|each|all)\s+(?:of\s+the\s+|the\s+)?(?:files?|modules?|components?|tests?|handlers?|routes?|endpoints?|packages?|services?|call ?sites?|usages?|occurrences?|references?|imports?)\b/i),
      matches(/\b(?:across|throughout)\s+(?:the\s+)?(?:codebase|repo|repository|project|monorepo)\b/i),
      matches(/\b(?:codebase|repo|repository|project)[-\s]wide\b/i),
      matches(/\b(?:whole|entire)\s+(?:codebase|repo|repository|project|monorepo)\b/i),
      matches(/\*\*\/|\*\.[a-z0-9]+/i),
      namesManyPaths,
      countsManyItems,
    ],
  },
  {
    name: 'repeated treatment',
    weight: 1,
    detectors: [
      matches(/\b(?:same|identical)\s+(?:change|edit|fix|transformation|treatment|pattern|refactor)\b/i),
      matches(/\b(?:everywhere|consistently|in bulk|bulk)\b/i),
      matches(/\bfind\s+and\s+replace\b/i),
      matches(/\b(?:migrate|port|convert|rename|replace|rewrite)\b[^.!?]{0,60}\b(?:all|every|each|everywhere|across)\b/i),
      matches(/\bapply\b[^.!?]{0,60}\bto\s+(?:all|every|each)\b/i),
    ],
  },
  {
    name: 'a check someone else should run',
    weight: 1,
    detectors: [
      matches(/\b(?:review|audit|double[-\s]?check|second opinion|sanity[-\s]?check|red[-\s]?team|adversarial|verify|validate)\b/i),
    ],
  },
  {
    name: 'wide recon',
    weight: 1,
    detectors: [
      matches(/\b(?:find|list|locate|search\s+for|look\s+for|grep\s+for)\b[^.!?]{0,30}\b(?:all|every|everywhere|anywhere)\b/i),
      matches(/\bwhere\s+(?:is|are)\b[^.!?]{0,60}\b(?:used|defined|called|referenced|imported)\b/i),
      matches(/\bwhich\s+files\b/i),
      matches(/\bmap\s+out\b|\btrace\s+through\b/i),
    ],
  },
]

/** Breadth alone, or any two of the rest. One weak signal by itself is a main-thread task with a keyword in it. */
export const THRESHOLD = 2

/**
 * The bar in prefer mode with no Jev key, where keywords are all there is to go on.
 *
 * One signal is enough there, but zero is still zero: a prompt carrying no delegation shape at all has nothing to
 * fan out, and spawning for it is the 6.37x with none of the reason. Raising this to 0 would fire on every prompt,
 * and is a one-character change for anyone who wants that.
 */
export const PREFER_THRESHOLD = 1

export const thresholdFor = (mode) => (mode === 'prefer' ? PREFER_THRESHOLD : THRESHOLD)

/**
 * What a prompt is carrying.
 *
 * `quiet` is not the same as a zero score: it means the prompt is not one this hook has any business reading, so
 * even the always mode stays silent on it. Three things are quiet: nothing, a slash command, and a wrapper Claude
 * Code generated and submitted itself.
 */
export const triage = (prompt) => {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.trim() === '' || isSlashCommand(text) || isSynthetic(text)) return { quiet: true, fired: [], score: 0, emit: false }
  const hits = FAMILIES.filter((family) => family.detectors.some((detect) => detect(text)))
  const score = hits.reduce((total, family) => total + family.weight, 0)
  return { quiet: false, fired: hits.map((family) => family.name), score, emit: score >= THRESHOLD }
}

// Every line below is the policy skill's, compressed. Nothing here argues for delegating: the first bullet is the
// answer on almost every prompt, and it is first for that reason.
const DECISION = [
  'Make the delegation call explicitly before you start, and say which way you went in one line.',
  '- Fits in one context? Do it on the main thread. Forcing delegation measured 6.37x the cost of a plain prompt for the same 100% pass rate.',
  '- Same fully-specified change across more files than one context holds: kelpie:mech-executor, specified in one shot, no open decisions left.',
  '- Wide read-only lookups where you want the answer and not the file dumps: kelpie:recon, on Haiku. Built-in Explore runs on your own model.',
  '- A claim a test, type check, lint, or build can settle: run that check. kelpie:verifier is only for claims no executable check reaches.',
  '- Judgment calls and security-sensitive work stay on the main thread. Any ad-hoc fan-out sets model explicitly.',
]

// prefer mode routes the work instead of arguing about whether to, and the routes that do the work name a model
// cheaper than an Opus session. That is the whole case for delegating on price: a subagent on the session's own model pays for the
// hand-off and saves nothing. A cheaper model is not enough on its own either: forcing delegation measured 6.37x a
// plain prompt at a 1.14x cheaper blended price, because the turn loop multiplied the tokens. Hence the size bar in
// the first line. The two exclusions stay, because neither is a cost question. Open design decisions have nothing measured behind handing them to a subagent
// at any tier, and Opus has been observed refusing delegated security work it accepts inline.
const ROUTES = [
  'Hand work to a subagent when it runs on a cheaper model than this session and the work is big enough to outrun the hand-off. A subagent on your own model pays for the hand-off and saves nothing, so where the cheapest model that fits is yours, do the work here.',
  '- Lookups that take more than a search or two: kelpie:recon, on Haiku. It reports what the code says, not what is wrong with it.',
  '- Fully-specified work: kelpie:mech-executor, on Sonnet unless you pass model: haiku for a pattern-only edit. Resolve every open decision first, then spec it in one shot with exact paths and acceptance criteria, because a subagent cannot ask you a question mid-task.',
  '- The same treatment across many files: a kelpie workflow, /kelpie:migrate-in-parallel or /kelpie:audit-many-files, which fans out and then settles correctness with one executable check.',
  '- A claim no test, type check, lint, or build can settle: kelpie:verifier. Where a check can settle it, run the check instead.',
  '- Still on the main thread whatever the mode: work with open design decisions left in it, and security-sensitive work. Any ad-hoc fan-out sets model explicitly.',
]

export const renderNote = ({ fired, mode = 'signals' }) => {
  // prefer mode with nothing fired only happens when the bar has been lowered to zero deliberately, and the routes
  // are the whole reason to lower it. Every other mode says the honest one-liner instead.
  if (fired.length === 0 && mode !== 'prefer') {
    return 'kelpie delegation triage: no delegation-shaped signal in this prompt. The main thread is the default; delegate only if the work does not fit one context.'
  }
  const body = mode === 'prefer' ? ROUTES : DECISION
  const carries = fired.length === 0
    ? 'this prompt carries no delegation-shaped signal, and you have set the bar to route it anyway'
    : `this prompt carries ${fired.join(', ')}`
  return [`kelpie delegation triage${mode === 'prefer' ? ' (prefer mode)' : ''}: ${carries}.`, ...body].join('\n')
}
