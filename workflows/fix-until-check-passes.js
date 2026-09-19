export const meta = {
  name: 'fix-until-check-passes',
  description: 'Repeatedly diagnose and fix a failing check, escalating tier after two failures, until it passes or attempts run out',
  phases: [{ title: 'Fix' }],
}

const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    passing: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['passing', 'summary'],
}

// Two attempts per tier is the orchestration skill's rule: a single failure can be a bad prompt, two are a capability signal.
// The second tier has no agentType on purpose: kelpie ships no judgment-executor role, so escalation goes to the
// session tier rather than to another pinned role. Omitting `model` is the deliberate choice, not an oversight.
const TIERS = [
  { name: 'kelpie:mech-executor', agentType: 'kelpie:mech-executor' },
  { name: 'session-tier', agentType: undefined },
]
const ATTEMPTS_PER_TIER = 2
const MAX_ATTEMPTS = TIERS.length * ATTEMPTS_PER_TIER

if (!args || !args.checkCommand) {
  throw new Error('fix-until-check-passes requires args.checkCommand: the shell command to run as the check')
}
const maxAttempts = args.maxAttempts ?? MAX_ATTEMPTS
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
  throw new Error(`fix-until-check-passes requires args.maxAttempts to be an integer from 1 to ${MAX_ATTEMPTS} (${ATTEMPTS_PER_TIER} attempts per tier)`)
}
const context = args.instructions || ''

const earlierAttempts = (history) => history.length === 0
  ? ''
  : `Earlier attempts already failed. Don't repeat an approach below unless you have new evidence it will work:\n${history.map((h) => `- Attempt ${h.attempt} (${h.tier}): ${h.summary}`).join('\n')}\n`

phase('Fix')
const history = []
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const tier = TIERS[Math.floor((attempt - 1) / ATTEMPTS_PER_TIER)]
  const previous = history[history.length - 1]
  if (previous && previous.tier !== tier.name) {
    log(`${ATTEMPTS_PER_TIER} failures at ${previous.tier}, escalating to ${tier.name}`)
  }
  const opts = { phase: 'Fix', schema: STATUS_SCHEMA, label: `attempt-${attempt}-${tier.name}` }
  if (tier.agentType) {
    opts.agentType = tier.agentType
  }
  const result = await agent(
    `${earlierAttempts(history)}Run this exact command: \`${args.checkCommand}\`. ${context ? `Context: ${context}. ` : ''}If it passes, report passing:true and stop. If it fails, diagnose the failure and make the smallest fix that addresses the root cause — do not disable, skip, or work around the check itself. After fixing, re-run the same command to confirm before reporting. Report passing:true only if you personally saw the command succeed after your fix.`,
    opts
  )
  const passing = !!result?.passing
  const summary = result?.summary || (result === null ? 'the agent returned no result' : '')
  history.push({ attempt, tier: tier.name, passing, summary })
  log(`Attempt ${attempt}/${maxAttempts} (${tier.name}): ${summary}`)
  if (passing) {
    return { passing: true, attempts: attempt, escalated: tier.name !== TIERS[0].name, history }
  }
}
return { passing: false, attempts: history.length, escalated: history.some((h) => h.tier !== TIERS[0].name), history }
