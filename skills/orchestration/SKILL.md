---
name: orchestration
description: Delegation policy for kelpie — when delegating actually pays, which role fits, and when to run a check instead of a verifier. Consult before spawning a subagent or writing a workflow script in a project where kelpie is installed.
---

kelpie ships two roles as plugin agents (invoke as `kelpie:<role>`): `mech-executor` and `verifier`.
It used to ship five.
The other three were removed after kelpie's own benchmark measured them, and the measurements are in this file because they change what you should do, not as trivia.

## Default to not delegating

Delegation is a cost, paid up front, recovered only in specific shapes.
Two measurements from kelpie's Stage 2 run (260 scored trials):

- Over 180 trials on ordinary coding tasks, Opus 5 spawned a subagent **zero times**, with kelpie installed and without.
  Installing the plugin changed nothing, because the model never reached for the mechanism.
- On 40 trials where delegation was forced through a workflow, the delegated arm cost **6.37x** the plain prompt for the **same 100% pass rate**.
  The gap decomposes as 7.27x the tokens against a 1.14x cheaper blended price.
  Output tokens, at 18.81x volume, drove it — not re-reading context.

The lesson is not "never delegate."
It is that a cheap worker does not make a task cheaper if delegating adds turns.
A spawn that runs a 9-turn internal loop to answer one question costs more than answering it inline, at any tier.

**Delegate when the work does not fit one context, or when independence is the point:**

- More files than one context holds, each needing the same treatment.
- Wide read-only search where you want the conclusion, not the file dumps.
- A check that must not be done by whoever wrote the thing.

**Do not delegate** a lookup you could do with one `Grep`, a judgment call you are better placed to make, or anything where the round trip costs more than the work.

## Pick the role

| Role | Model | Effort | For |
|---|---|---|---|
| built-in `Explore` | session, capped at Opus | — | Read-only recon and search. Not a kelpie role; use the one Claude Code already ships |
| `kelpie:mech-executor` | sonnet | low | Fully-specified mechanical work: pattern refactors, convention-following tests, docs, bulk edits — no open decisions left |
| `kelpie:verifier` | inherit | medium | Adversarial check of a claim **no executable check can settle** |

**There is no judgment-executor role.**
Work with open design decisions in it stays on the main thread.
Nothing measured supports handing judgment to a cheaper model, and a pinned-up executor under a cheaper session just inverts the hierarchy.

**Sonnet on `mech-executor` is measured, and scoped.**
Across 896 spawns it changed 762 of 762 target files and touched 0 of 67 decoys, needed zero retries, and produced output that shipped untouched in 16 of 20 trials.
That evidence covers **fully-specified work only**.
On open-ended work the same tier fails expensively rather than cheaply, so the "no open decisions left" bar in the role's description is load-bearing, not a style note.

**Recon goes to built-in `Explore`, not a pinned-cheap role.**
kelpie used to ship a Haiku `scout`.
Measured, it manufactured 84 leads that a plain Opus prompt never generated, and the verifier then spent real money rejecting them.
A cheap finder upstream of an expensive filter loses to not making the noise.
`Explore` inherits the session model capped at Opus on the Claude API, so it is already tiered where tiering is safe.
To run it cheaper, override it at user or project scope — a plugin cannot, because plugin agents are namespaced and the override is scoped to a bare `Explore`.

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

If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set (Claude Code v2.1.257+), it overrides every subagent's `model` field — both kelpie roles and the built-in Explore/Plan agents — forcing them onto `CLAUDE_CODE_SUBAGENT_MODEL`, or the session model if that is the only one set.
Two exceptions still run on the session model regardless: a forked conversation, and a skill run in a subagent with `model: inherit`.
If a role appears to be running on the wrong model despite correct frontmatter, check this variable and the Claude Code version before assuming kelpie is broken.
