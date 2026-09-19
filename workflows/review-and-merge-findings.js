export const meta = {
  name: 'review-and-merge-findings',
  description: 'Review a target across several dimensions, adversarially verify each finding, and return only what survives',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['real', 'reasoning'],
}

if (!args || !args.target) {
  throw new Error('review-and-merge-findings requires args.target: what to review (a diff description, file list, or PR reference)')
}
const dimensions = args.dimensions && args.dimensions.length ? args.dimensions : ['correctness', 'security', 'simplification']

phase('Review')
const results = await pipeline(
  dimensions,
  // Reviewing is judgment work, so the reviewer runs at the session tier. Omitting `model` is the deliberate choice
  // here: kelpie ships no judgment-executor role, because nothing measured supports handing this to a cheaper model.
  (dim) => agent(
    `Review the following for ${dim} issues only: ${args.target}. Report every real issue you find, with file/line where applicable and a one-sentence summary. An empty findings array is valid and expected if there's nothing to report — don't invent issues.`,
    { phase: 'Review', schema: FINDINGS_SCHEMA, label: `review:${dim}` }
  ),
  async (reviewResult, dim) => {
    const findings = reviewResult?.findings || []
    if (findings.length === 0) return { dimension: dim, findings: [] }
    const verified = await parallel(findings.map((f) => () =>
      agent(
        `A reviewer flagged this ${dim} issue: "${f.summary}"${f.file ? ` in ${f.file}` : ''}${f.line ? ` around line ${f.line}` : ''}. Context under review: ${args.target}. Verify independently whether this is a real, actionable issue or a false positive. Default to real:false if you can't confirm it yourself.`,
        { agentType: 'kelpie:verifier', phase: 'Verify', schema: VERDICT_SCHEMA, label: `verify:${dim}` }
      ).then((v) => ({ ...f, dimension: dim, ...v }))
    ))
    return { dimension: dim, findings: verified.filter(Boolean).filter((v) => v.real) }
  }
)

const confirmed = results.filter(Boolean).flatMap((r) => r.findings)
log(`${confirmed.length} finding(s) confirmed across ${dimensions.length} dimension(s)`)
return { target: args.target, dimensions, findings: confirmed }
