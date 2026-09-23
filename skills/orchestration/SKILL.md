---
name: orchestration
description: Delegation policy for kelpie — when delegating actually pays, which role and model fit, and when to run a check instead of a verifier. Consult before spawning a subagent or writing a workflow script in a project where kelpie is installed.
---

kelpie ships four roles as plugin agents (invoke as `kelpie:<role>`): `recon`, `analyst`, `mech-executor` and `verifier`.
It once shipped five.
Three were removed after kelpie's own benchmark measured them, and one of those, a Haiku finder, came back as `recon` with a narrower job.
The measurements are in this file because they change what you should do, not as trivia.

## Default to not delegating at your own model's price

Delegation is a cost, paid up front, recovered only in specific shapes.
A subagent on the same model as your session pays for the hand-off and saves nothing on price, so the saving has to come from a cheaper model doing work big enough to outrun the hand-off.
Two measurements from kelpie's Stage 2 run (260 scored trials):

- Over 180 trials on ordinary coding tasks, Opus 5 spawned a subagent **zero times**, with kelpie installed and without.
  Installing the plugin changed nothing, because the model never reached for the mechanism.
- On 40 trials where delegation was forced through a workflow, the delegated arm cost **6.37x** the plain prompt for the **same 100% pass rate**.
  The gap decomposes as 7.27x the tokens against a 1.14x cheaper blended price.
  Output tokens, at 18.81x volume, drove it — not re-reading context.

The lesson is not "never delegate."
It is that a cheap worker does not make a task cheaper if delegating adds turns.
A spawn that runs a 9-turn internal loop to answer one question costs more than answering it inline, at any tier.

**Delegate when a cheaper model can do the work, when the work does not fit one context, or when independence is the point:**

- Lookups that take more than a search or two: `kelpie:recon`, on Haiku.
- Read-only questions a lookup cannot answer, such as tracing a flow or checking a claim against the code: `kelpie:analyst`, on Sonnet.
- Fully-specified work, once every decision in it is made: `kelpie:mech-executor`, on Sonnet.
- More files than one context holds, each needing the same treatment.
- A check that must not be done by whoever wrote the thing.

**Do not delegate** a lookup you could do with one `Grep`, a judgment call you are better placed to make, or anything where the round trip costs more than the work.

## Pick the role

| Role | Model | Effort | For |
|---|---|---|---|
| `kelpie:recon` | haiku | — | Read-only lookups: where something is defined or used, which files match, what the code says. Facts with `path:line`, never findings |
| `kelpie:analyst` | sonnet | medium | Read-only questions that need reasoning: trace a flow, explain behaviour, check a claim against the code. One question, `path:line` evidence, inferences marked |
| `kelpie:mech-executor` | sonnet | low | Fully-specified mechanical work: pattern refactors, convention-following tests, docs, bulk edits — no open decisions left |
| `kelpie:verifier` | inherit | medium | Adversarial check of a claim **no executable check can settle** |

**There is no judgment-executor role.**
Work with open design decisions in it stays on the main thread.
`kelpie:analyst` reasons about code but decides nothing: where an answer turns on a design choice or an acceptable risk, it lays out what the code shows and stops.
Nothing measured supports handing judgment to a cheaper model, and a pinned-up executor under a cheaper session just inverts the hierarchy.

**Sonnet on `mech-executor` is measured, and scoped.**
Across 896 spawns it changed 762 of 762 target files and touched 0 of 67 decoys, needed zero retries, and produced output that shipped untouched in 16 of 20 trials.
That evidence covers **fully-specified work only**.
On open-ended work the same tier fails expensively rather than cheaply, so the "no open decisions left" bar in the role's description is load-bearing, not a style note.

**Recon goes to `kelpie:recon`, and it only looks things up.**
Built-in `Explore` inherits your session's model, capped at Opus, so under an Opus session it is an Opus subagent: a hand-off with no cheaper price behind it.
`kelpie:recon` runs on Haiku.
Its brief is narrow on purpose.
kelpie used to ship a Haiku `scout` that was asked to find problems, and it manufactured 84 leads that a plain Opus prompt never generated, which the verifier then spent real money rejecting.
So `recon` reports what the code says, with `path:line`, and never what is wrong with it.
Do not send it to find bugs, audit, or review; that is judgment, and judgment stays with you.
A question that needs reasoning but no decision, such as whether a documented claim matches the code, goes to `kelpie:analyst` instead: one exact question, answered with evidence.
The analyst is not a bug hunter either. Its pin is not measured.
For a lookup one `Grep` answers, run the `Grep`.

**Security work gets no special role.**
kelpie used to pin a `security-executor` to Opus on the theory that cheaper models refuse benign defensive work more readily.
That rationale is wrong: the frontier models carry the cyber classifiers, and Opus has been observed refusing *delegated* security tasks that it accepts inline.
Do security-sensitive work on the main thread.

**Escalate after two failures, not one.**
A single failure can be a bad prompt rather than a capability ceiling — respec and retry once at the same tier before moving the work to the main thread.

## Run the check before you run a verifier

If a test suite, type checker, linter, or build settles the question, run it.
Over 20 migration trials, `node --test` surfaced every behaviour-breaking failure first, naming the failing file, and the verifier found nothing on top of it while consuming 74.8% of the arm's cost.

`kelpie:verifier` earns its cost only where no executable check exists: a design claim, a review finding, an assertion about behaviour nothing asserts on yet.
There, the fresh-context independence is the whole value — self-certification from the context that wrote the code misses its own blind spots by construction.

`inherit` on `verifier` is deliberate.
Adversarial checking is the one place you want the session's full capability rather than a cheaper tier, and it keeps the checker from out-ranking the session that called it.

## Spec delegations completely, in one shot

A subagent cannot ask a clarifying question mid-task.
Before delegating, write the task so it does not need one:

- State the goal AND the why — a worker that understands the point makes better calls on the parts you did not spell out.
- Give exact file paths, exact symbol names, and the acceptance criteria, not "the auth module" or "make it work."
- If the task has a part that requires judgment, resolve that judgment call yourself before delegating.

## Set an explicit model on every ad-hoc fan-out

Any `parallel()`/`pipeline()` call or one-off Agent delegation that is not going through a named role above still needs a deliberate model choice.
An ultracode fan-out can spawn up to 1,000 agents; every one defaulting to the session model because nobody set `model` is the cost profile kelpie exists to change.
Deliberate inheritance is fine — silent inheritance is not.

## Workflow scripts: assign a tier to each stage

Use `agent()`'s `agentType` option to call a kelpie role by name rather than restating a model/effort tier inline, so the tiering decision stays in the role files.
**A plugin's own agents are namespaced even from inside the plugin's own scripts** — write `agentType: 'kelpie:mech-executor'`, not `agentType: 'mech-executor'`; the bare name resolves against user and project agents only.
For a stage that matches no role, set `model`/`effort` directly on `agent()`, or omit `model` as an explicit choice to run that stage at the session tier.

## One landmine to know about

If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set (Claude Code v2.1.257+), it overrides every subagent's `model` field — every kelpie role and the built-in Explore/Plan agents — forcing them onto `CLAUDE_CODE_SUBAGENT_MODEL`, or the session model if that is the only one set.
Two exceptions still run on the session model regardless: a forked conversation, and a skill run in a subagent with `model: inherit`.
If a role appears to be running on the wrong model despite correct frontmatter, check this variable and the Claude Code version before assuming kelpie is broken.

## Making this decision happen every time

kelpie ships a `UserPromptSubmit` hook that checks each prompt and puts this decision in front of you at the moment it matters.
It runs in `prefer` mode unless `/kelpie:delegation-triage` sets another mode, per project or per user.

Which mode it is in changes what you get:

- `prefer`, the default, routes work to a subagent on a cheaper model when the work is big enough to outrun the hand-off, and says "do it here" when the cheapest model that fits is your own. With a Jev key and "Send prompts to Jev" on, it asks about every prompt it may read and names one route and one model. On the first prompt of a headless `claude -p` session it cannot read your model, so the route says which model you have to be above to take it; you know what you run on. Open design decisions and security-sensitive work stay on the main thread whatever the note says, because neither is a cost question.
- `signals` injects a compressed form of the policy above on delegation-shaped prompts, and `always` does it on every prompt. Both lead with the main thread, so they are this file.
