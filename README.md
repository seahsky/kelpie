# kelpie

A Claude Code plugin that decides **when delegating is worth it**, and what each spawn costs when it happens.

Named for the Australian working dog: the shepherd sets policy once, the dog directs, the flock does the moving.

## What it ships

| Component | | For |
|---|---|---|
| `kelpie:mech-executor` | sonnet, low | Fully-specified mechanical work. No open decisions left |
| `kelpie:verifier` | inherit, medium | Adversarial check of a claim **no executable check can settle** |
| [policy skill](skills/orchestration/SKILL.md) | ~80 tok always-on | When delegating pays, which role fits, and when to run a check instead |
| [workflow scripts](workflows/) | 4 | `/kelpie:audit-many-files`, `/kelpie:fix-until-check-passes`, `/kelpie:migrate-in-parallel`, `/kelpie:review-and-merge-findings` |
| [spawn gate](hooks/jev-gate/) | off by default | Decides model and effort per spawn instead of once |

Recon goes to Claude Code's built-in `Explore`, not to a kelpie role.

## The spawn gate

The table above is the ordinary policy: one model and one effort per role, decided once, for every task that role ever runs. A pin is a bet that every spawn of a role looks alike. They don't. A three-line rename and a thousand-line reshape both arrive as `mech-executor`.

The gate decides per spawn instead. It runs as a `PreToolUse` hook on the `Workflow` tool, asks [TypeSafe AI's Jev](https://docs.typesafe.ai) how mechanical and how fully specified each item's work is, and writes a per-item decision the workflow reads.

**It sends your code off the machine.** For each path in the call, the gate reads the file and POSTs an excerpt — up to 120 lines or 6000 characters — plus the path and line count to `api.typesafe.ai`. That is the mechanism, not a side effect: the questions are about the file's contents. Files outside the working directory are refused and never read, symlinks included. Setting `jev_api_key` is what turns this on; leave it empty and nothing is read or sent.

**It only routes down.** The rungs on offer are fixed from your session's model *before* Jev is asked: haiku/sonnet/opus under an Opus or Fable session, haiku/sonnet under a Sonnet one. Jev is asked about the work, never about which model should run it. That split is the whole safety property. A decision model that misreads a task can pick the wrong rung; it cannot invent a rung above the session you're paying for, or above `xhigh`.

**Every failure falls back to the pin.** A timeout, an unexpected shape, an unestablished session model — each one leaves the spawn exactly as the workflow had it. With no key configured the gate emits nothing at all, and `tests/workflows.test.mjs` pins that spawn by spawn, so an install without a key cannot drift.

Two structural limits worth knowing before you reach for it:

- It reaches `audit-many-files` and `migrate-in-parallel` only. `fix-until-check-passes` and `review-and-merge-findings` never name their work in the `Workflow` call's arguments, so there is nothing for the gate to read.
- `Workflow` is the only reachable point. Role spawns fire `SubagentStart`, which cannot block, and workflow scripts run in a vm context with no network. The `Agent` tool's schema has no effort parameter at all; workflow `agent()` opts do.

**Nothing measured supports turning it on.** Stage 4 is the experiment and it has not been run. Treat the gate as a mechanism that works, not a saving that's been demonstrated.

Where it should matter most is an ultracode session: effort is set to `xhigh`, the 20-subagent concurrency limit is waived, and every spawn defaults to the session model unless something pins it. Ultracode decides *how many* agents fan out; the gate decides what each one costs. A Fable session has the most to win, since Opus sits a rung below it.

**One licence point** for anyone who measures this themselves. TypeSafe's MCA §2.3(f) forbids publishing benchmarks or performance information about the Services, and that subsection has no consent path of its own — permission takes a signed amendment (§15.7), waiver (§15.8), or Order term (§15.14). Naming TypeSafe is *not* restricted: §15.4 withholds a trademark licence and bars announcing the customer relationship, and nothing in either document addresses naming a vendor in code, config, or docs. Say that you use it; don't publish what it cost you per call or how fast it answered.

## What the benchmark found

260 scored trials on a subscription, priced from a frozen table. Ordinary coding tasks from Terminal-Bench 2.1 (mode A), and forced-delegation workflows on generated repos (mode B).

- **Opus 5 spawned a subagent zero times across all 180 mode A trials**, with kelpie installed and without. The plugin loaded cleanly every time; the model never reached for the mechanism. A tiering plugin cannot save money on delegation that never happens.
- **Forcing delegation cost 6.37x for the same 100% pass rate.** $170.00 against $26.69 for a plain prompt. The gap is 7.27x the tokens against a 1.14x cheaper blended price — the cheap tiers worked and were swamped. Output tokens at 18.81x volume drove it.
- **A Haiku `scout` was actively harmful.** It generated 84 candidate findings a plain prompt never produced, and the verifier spent real money rejecting them.
- **The verifier was competent and still not worth it.** Over 418 leads it never dropped a true defect and rejected about three quarters of the bad ones. On the migration half, `node --test` surfaced every behaviour-breaking failure first, naming the file, while the verifier took 74.8% of the arm's cost and found nothing on top.
- **Sonnet as a mechanical executor held up.** 896 spawns changed 762 of 762 target files, touched 0 of 67 decoys, needed zero retries, and shipped untouched in 16 of 20 trials.
- **A simpler lever beats the plugin.** Stage 3, 180 trials: same model at `low` effort cut cost per solved task **36.9%** for a 3.3-point pass-rate drop; a Sonnet main session cut it **34.7%** and passed 3.3 points higher. The run's own noise floor reads 6.0%, so both clear it. Neither needs a plugin.

**Mode A's published number was an artefact, and is retracted.** The estimator compared a ratio of aggregate arm totals, letting a few expensive tasks decide the comparison. Against two arms that were operationally identical it read **-13.8%** where the true effect is zero by construction. The per-task paired estimator reads **-0.3%**. Mode A is **inconclusive**. Mode B's drop survives.

Two health warnings. Mode B audit tasks were scored against answer keys while six real defects sat on lines no key listed, so anything from that grader is a floor. And changing a pre-registered decision rule after reading results is what pre-registration exists to stop; it's declared at the top of the plan rather than buried.

**The harness, the plan, and the per-trial rows are not published.** Everything above is an assertion you cannot check — the author's report of his own results, not evidence. The retraction is included for the same reason it was written, and is equally unverifiable from here.

## Why the pins are what they are

`mech-executor` is pinned to Sonnet because that pin is measured, and because the "no open decisions left" bar is exactly what the measurement covers. On open-ended work the same tier fails expensively rather than cheaply.

`verifier` stays on `inherit` because adversarial checking is the one place you want the session's full capability, and inheriting keeps the checker from out-ranking the session that called it. Repricing it doesn't rescue the delegated arm: Sonnet is a uniform 0.40x of Opus across every token class, taking mode B from $170.00 to $102.31, still 3.8x a plain prompt. The cost was never the pin, it was the turn loop.

Three roles shipped in an earlier build and did not survive measurement:

- **`scout` (haiku).** Replaced by built-in `Explore`, which already inherits the session model capped at Opus. A pinned-cheap finder upstream of an expensive filter loses to not making the noise.
- **`security-executor` (opus).** The rationale was that cheaper models refuse benign defensive work more readily. That's backwards: frontier models carry the cyber classifiers, and Opus has been observed refusing *delegated* security tasks it accepts inline. Security work stays on the main thread.
- **`executor` (inherit).** Nothing measured supports handing open design decisions to a subagent at any tier, and `inherit` made it a strictly more expensive way to run the session model.

## What a plugin can't do

**Override the built-in `Explore`.** That override is scoped to a user or project subagent named `Explore`, and plugin agents are namespaced — a plugin's own `Explore.md` registers as `kelpie:Explore`, which nothing calls automatically. Built-in Explore already inherits the session model capped at Opus, so the saving is Opus→Haiku on background searches. To take it, add `~/.claude/agents/Explore.md`:

```markdown
---
name: Explore
description: Overrides the built-in Explore agent to run on Haiku.
model: haiku
---
```

**Set `model` or `fallbackModel` in your settings.** A plugin's bundled `settings.json` supports only `agent` and `subagentStatusLine`. Pinning your main session is a two-line manual addition to your own settings.

**Reach its own agents by bare name.** Inside a workflow script, `agentType: 'mech-executor'` resolves against user and project agents only. The working form is `agentType: 'kelpie:mech-executor'`. This caught a real bug during development.

**Survive `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.** Set (v2.1.257+), it overrides *every* subagent's `model` field, both kelpie roles and built-in Explore/Plan, forcing them onto `CLAUDE_CODE_SUBAGENT_MODEL`. Forks and skills run with `model: inherit` are the exceptions. If roles all seem to run on one model despite correct frontmatter, check this before assuming the plugin is broken.

## Cost of installing it

From `claude plugin details kelpie` against 0.1.0 — the CLI's estimates, not measured token accounting.

| Component | Always-on | On-invoke |
|---|---|---|
| `orchestration` skill | ~80 tok | ~2.4k tok |
| `kelpie:mech-executor` | ~140 tok | ~190 tok |
| `kelpie:verifier` | ~100 tok | ~450 tok |
| **Total always-on** | **~317 tok** | — |

Down from ~554 tok when five roles shipped. Dropping three agents saved more than the rewritten policy skill added.

## What is still unknown

- **Whether delegation pays on work too large for one context.** Every trial fit comfortably in one. This is the case the remaining roles exist for, and it is untested.
- **Whether deciding per spawn beats deciding once.** The gate is the mechanism, Stage 4 is the experiment, and neither has produced a number.

## Install

```
claude plugin marketplace add seahsky/kelpie
claude plugin install kelpie@kelpie
```

For a single session without installing anything persistent:

```
claude --plugin-dir /path/to/kelpie
```

## Prior art

kelpie started as the orchestrator/executor split from [pilotfish](https://github.com/Nanako0129/pilotfish), whose own PR #43 measured delegation at 2.14x cost on a small task. Others covering similar ground: [moai-adk](https://github.com/modu-ai/moai-adk), [sous-chef](https://github.com/tomascupr/sous-chef), [frugal](https://github.com/ThomasLangbroek/frugal), [fable-baton](https://github.com/realgarit/fable-baton) (measured flat or higher total cost on its own 3-task comparison), [CoalTipple](https://github.com/TheColliery/CoalTipple).

The name is not clear in this space: `kelpie` is taken on npm, and an active cluster of GitHub repos uses it in the same niche. Kept and disclosed rather than hidden.

## License

MIT — see [LICENSE](LICENSE).
