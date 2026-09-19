// Each spawn below can be redirected by kelpie's optional spawn gate (hooks/jev-gate/). The gate runs as a PreToolUse
// hook on the Workflow tool, so it sees this call's `args` before the script runs, and writes a per-item decision into
// `args.gate`. With no gate configured there is no `args.gate`, and every spawn keeps the role and the frontmatter pins
// it has always had. tests/workflows.test.mjs pins that ungated behaviour exactly, so the gate cannot change it.
export const meta = {
  name: 'audit-many-files',
  description: "Audit a list of files against a specified concern, verifying each candidate finding before reporting it",
  phases: [{ title: 'Audit' }, { title: 'Verify' }],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['description'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['confirmed', 'reasoning'],
}

if (!args || !Array.isArray(args.paths) || args.paths.length === 0) {
  throw new Error('audit-many-files requires args.paths: an array of file paths to audit')
}
// Auditing the same file twice doubles its cost and double-counts its findings.
const normalizedPaths = args.paths.map((p) => p.replace(/^(\.\/)+/, ''))
const duplicatePaths = [...new Set(normalizedPaths.filter((p, i) => normalizedPaths.indexOf(p) !== i))]
if (duplicatePaths.length > 0) {
  throw new Error(`audit-many-files requires unique args.paths; duplicates: ${duplicatePaths.join(', ')}`)
}
const concern = args.concern || 'bugs, correctness issues, or unsafe patterns'

const gate = args.gate || null
// A decision's agentType of null means the session tier on purpose, so "decision present" and "field set" are
// different questions. With no decision at all, the shipped default stands untouched.
const withGate = (opts, decision, shippedAgentType) => {
  const agentType = decision ? decision.agentType : shippedAgentType
  if (agentType) opts.agentType = agentType
  if (decision && decision.model) opts.model = decision.model
  if (decision && decision.effort) opts.effort = decision.effort
  return opts
}

const results = await pipeline(
  args.paths,
  // The finder runs at the session tier unless the gate says otherwise. Omitting `model` here in the shipped script is
  // a deliberate choice, not an oversight: measured on kelpie's Stage 2 run, a Haiku finder manufactured 84 leads a
  // plain session-tier prompt never generated, and the verify stage below then paid to reject them. A cheap finder
  // upstream of an expensive filter loses to not making the noise.
  (path) => agent(
    `Read the file at ${path}. Check it specifically for: ${concern}. Report every instance you find, with its line number and a one-sentence description. If you find nothing, return an empty findings array — do not invent issues to have something to report.`,
    withGate({ phase: 'Audit', schema: FINDINGS_SCHEMA, label: `audit:${path}` }, gate && gate.byPath ? gate.byPath[path] : null, undefined)
  ),
  async (auditResult, path) => {
    const findings = auditResult?.findings ?? []
    if (findings.length === 0) return { path, findings: [] }
    // A finding in a file the gate rated hard turns on behaviour the file does not state on its face, so it is judged
    // at the review tier that path was given rather than at the one tier chosen for the whole stage. The review tier
    // is a raise, never a cut: see decideReview in hooks/jev-gate/policy.mjs.
    const pathDecision = gate && gate.byPath ? gate.byPath[path] : null
    const verifyDecision = (pathDecision && pathDecision.review) || (gate ? gate.verify : null)
    const verified = await parallel(findings.map((f) => () =>
      agent(
        `A prior pass flagged this in ${path}: "${f.description}"${f.line ? ` (around line ${f.line})` : ''}. Concern being audited: ${concern}. Read the file yourself and confirm whether this is a real instance of that concern, or a false positive. Default to unconfirmed if you can't verify it directly.`,
        withGate({ phase: 'Verify', schema: VERDICT_SCHEMA, label: `verify:${path}` }, verifyDecision, 'kelpie:verifier')
      ).then((v) => ({ ...f, ...v }))
    ))
    return { path, findings: verified.filter(Boolean).filter((v) => v.confirmed) }
  }
)

const confirmed = results.filter(Boolean).filter((r) => r.findings.length > 0)
const totalFindings = confirmed.reduce((sum, r) => sum + r.findings.length, 0)
log(`${totalFindings} confirmed finding(s) across ${confirmed.length} of ${args.paths.length} file(s)`)
return { concern, filesAudited: args.paths.length, results: confirmed }
