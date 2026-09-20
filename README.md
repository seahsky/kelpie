# kelpie

A Claude Code plugin that decides **when delegating is worth it**, and what each spawn costs when it happens.

Named for the Australian working dog: the shepherd sets policy once, the dog directs, the flock does the moving.

Its own benchmark says delegate *less*, not more. The plugin is built around that result.

## Install

```
claude plugin marketplace add seahsky/kelpie
claude plugin install kelpie@kelpie
```

That gives you two roles, a policy skill, and four workflow commands. Both hooks stay off until you turn them on.

To try it without installing anything:

```
claude --plugin-dir /path/to/kelpie
```

## What it ships

| Component | | For |
|---|---|---|
| `kelpie:mech-executor` | sonnet, low | Fully-specified mechanical work. No open decisions left |
| `kelpie:verifier` | inherit, medium | Adversarial check of a claim **no executable check can settle** |
| [policy skill](skills/orchestration/SKILL.md) | ~80 tok always-on | When delegating pays, which role fits, when to run a check instead |
| [workflow scripts](workflows/) | 4 | `/kelpie:audit-many-files`, `/kelpie:fix-until-check-passes`, `/kelpie:migrate-in-parallel`, `/kelpie:review-and-merge-findings` |
| [delegation triage](hooks/delegation-triage/) | off by default | Puts the delegate-or-not decision in front of the model on prompts where it could go either way |
| [spawn gate](hooks/jev-gate/) | off by default | Decides model and effort per spawn instead of once. Needs an API key, and sends code off the machine |

Recon goes to Claude Code's built-in `Explore`, not to a kelpie role.

## The delegation triage

Turn it on with `/kelpie:delegation-triage`, per project or per user. It writes one config file, so there is no `settings.json` entry to add and nothing to redo after an upgrade.

A `UserPromptSubmit` hook reads each prompt and injects a short note when the prompt looks like work that might be worth fanning out. It exists because a policy skill only helps if the model reads it at the moment it matters, and measured over 180 trials it did not.

The note leads with "do it on the main thread", because that is the right answer on almost every prompt. It never rewrites your prompt: it adds a paragraph of context and nothing else, about 270 tokens for the full note. A hook that fails, times out, or reads a payload it does not understand emits nothing, which leaves the prompt as you typed it. A Jev call that fails is narrower and does not silence the turn: the mode falls back to the note it would have shown with no key.

| Mode | What it does |
|---|---|
| `signals` | Note only on delegation-shaped prompts. Start here |
| `always` | Note on every prompt. Costs context every turn |
| `prefer` | The note routes work to a role or a workflow instead of arguing against it. This is the opt-in to delegating by default, and to the 6.37x below |
| `off` | Nothing, same as never turning it on |

"Review this function" stays silent. "Review the new handlers and verify every route still authenticates" does not. Neither does "run all the tests", because breadth after an execution verb is an argument to one command.

Two costs. The hook starts a node process on every prompt in every install, including installs that never enable it. And nothing measured supports it: zero spawns means the model does not reach for delegation on its own, not that a nudge would have paid.

### prefer mode asks, rather than guessing from keywords

Give the plugin a Jev API key and `prefer` mode stops deciding from the words in your prompt. It sends the prompt instead and gets back five answers, which name one route: whether splitting the work costs less than doing all of it in this session, whether it is read-only, whether anything is still undecided, how hard it is, and whether it is a long job. The last two run the same difficulty and review ladders the spawn gate runs per file.

```
kelpie delegation triage (prefer mode), decided with jev: delegate this.

Splitting the work costs less than doing all of it in this session (delegation_saves 0.9).
- Spawn kelpie:mech-executor, model sonnet, effort medium: moderate (difficulty 1.1).
- Spec it in one shot: exact file paths, exact symbol names, acceptance criteria, and why the
  work matters. A subagent cannot ask you a question mid-task.
- Security-sensitive work stays in this session whatever this says. Opus has been observed
  refusing delegated security tasks that it accepts inline.
```

Splitting costing more than staying is the one answer that stops `prefer` mode delegating, which is the inversion the mode is for.

Three things to know before you set a key with `prefer` mode on.

- **Every prompt goes to a third party**, before the turn starts. Not slash commands, and not the notices Claude Code generates itself, but everything else. `KELPIE_TRIAGE_CONSULT=off` keeps `prefer` mode and keeps your prompts off the wire.
- **Every turn waits for it**, up to six seconds over two attempts. `KELPIE_TRIAGE_BUDGET_MS` and `KELPIE_TRIAGE_REQUEST_MS` change that.
- **Nothing here can fail a turn.** A timeout, an error, or an unsure answer on the question that decided the route leaves `prefer` mode saying exactly what it says with no key. An unsure `difficulty` is narrower: the route keeps its agent and names no model, so the spawn inherits yours.

The route never climbs above your session's own model. On the first prompt of a session there is no assistant turn to read a model from, so the route names no model and the spawn inherits yours.

This is the newest part of kelpie and the least measured. It is built because the alternative was worse: on ten real tickets `prefer` mode scored zero on every keyword family and said nothing, and the bar that catches those prompts catches every prompt.

## The decision log

Point `KELPIE_LOG` at a file, or add `"log": "/path/to/kelpie.jsonl"` to your `kelpie-triage.json`, and both hooks append one JSON line per decision.

```json
{"ts":"2026-09-20T06:12:18.349Z","hook":"delegation-triage","event":"decision","mode":"prefer",
 "score":0,"fired":[],"emitted":true,"reason":"score 0 clears the bar of 0","prompt_chars":23,
 "prompt_sha256":"285d76548d032558","note_chars":1067}
```

**Silence is logged too.** A prompt that got no note is recorded with the reason it got none, which is the number that tells you whether your mode is doing anything. kelpie's own paired A/B ran ten tickets in `prefer` mode, the note fired on none of them, and nothing recorded it, so the run read as a measurement of the triage while measuring the plugin's presence.

The gate writes to the same file: one `jev_request` per file, naming the path, the excerpt size and a hash of exactly what was sent, one `jev_attempt` per HTTP call with its status and latency, and one `jev_decision` with the answer and what it decided. A `file_skipped` line records every path the containment check refused to read. `KELPIE_GATE_LOG` still works and still wins for the gate alone.

`prefer` mode's own calls land in the same three events with `"stage":"prompt"` and no path, since nothing from your repository is sent. The five answers are on its `jev_decision` line, together with the route they produced. The `decision` line that follows carries `decided_by` and a summary of that route, so reading the pair back tells you what kelpie told the model to do rather than what it was configured to do.

Prompt text and file excerpts are **not** written unless you ask by name, with `KELPIE_LOG_PROMPTS=1` and `KELPIE_LOG_EXCERPTS=1`. Without them the log carries lengths and a truncated SHA-256, which is enough to tell two prompts apart and to match a prompt you already have. It is not confidentiality: the hash is unkeyed, so anyone holding the log can confirm a guess at a short or predictable prompt. Treat the log as sensitive if the prompts were. A log that cannot be written is dropped rather than failing your turn.

## The spawn gate

Each role carries one model and one effort for every task it will ever run. A three-line rename and a thousand-line reshape both arrive as `mech-executor`. The gate decides per spawn instead. It runs as a `PreToolUse` hook on the `Workflow` tool, asks [TypeSafe AI's Jev](https://docs.typesafe.ai) how mechanical and how fully specified each item is, and writes a per-item model and effort that the workflow reads.

### Turning it on

1. **Get a key** at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). The gate calls `https://api.typesafe.ai/v1/systemone` with `jev-latest`, on your key and your bill.
2. **Give it to the plugin.** Already installed: run `/plugin` and use its configure flow. Installing now: answer the prompt Claude Code shows as it enables the plugin, or pass it on the install line.

   ```
   claude plugin install kelpie@kelpie --config jev_api_key=YOUR_KEY
   ```

   The install line puts your key in your shell history; `/plugin` does not. A `sensitive` option never appears in the `/config` panel, so `/plugin` is the route to it afterwards.
3. **Restart the session.** The hook reads the key from its environment, and that environment is built at session start.

Clear the option to turn it back off. No key means no calls, no reads, and no output.

The same key also turns on the prompt consult described above, but only if the triage is in `prefer` mode. If you want the gate and not that, set `KELPIE_TRIAGE_CONSULT=off`.

### Before you turn it on

**It sends your code off the machine.** For each path in a gated call, the gate reads the file and POSTs an excerpt, up to 120 lines or 6000 characters, plus the path and line count. The questions are about the file's contents, so this is the mechanism and not a side effect, and it happens before you get a chance to decline the call. Files outside the working directory are refused, symlinks included. With the triage in `prefer` mode, your prompts go too.

**It only routes down.** The rungs are fixed from your session's model *before* Jev is asked: haiku/sonnet/opus under an Opus or Fable session, haiku/sonnet under a Sonnet one. Jev is asked about the work, never about which model should run it. A wrong answer picks a wrong rung; it cannot invent one above the session you are paying for.

**Every failure falls back to the pin.** A timeout, an unexpected shape, an unestablished session model: each leaves the spawn exactly as the workflow had it.

**It reaches two of the four workflows.** `audit-many-files` and `migrate-in-parallel` name their work in the call's arguments. The other two do not, so there is nothing to read.

Where it should matter most is an ultracode session: effort is `xhigh`, the 20-subagent limit is waived, and every spawn defaults to the session model. Ultracode decides *how many* agents fan out; the gate decides what each one costs. A Fable session has the most to win, since Opus sits a rung below it.

**Licence, if you measure this yourself.** TypeSafe's MCA §2.3(f) forbids publishing benchmarks or performance figures about their service, and no consent path exists short of a signed amendment. Naming TypeSafe is not restricted. Say that you use it; don't publish what it cost you per call or how fast it answered.

## What the benchmark found

260 scored trials on a subscription, priced from a frozen table. Ordinary coding tasks from Terminal-Bench 2.1 (mode A), and forced-delegation workflows on generated repos (mode B).

- **Opus 5 spawned a subagent zero times across all 180 mode A trials**, with kelpie installed and without. The plugin loaded cleanly every time; the model never reached for the mechanism. A tiering plugin cannot save money on delegation that never happens.
- **Forcing delegation cost 6.37x for the same 100% pass rate.** $170.00 against $26.69 for a plain prompt. That is 7.27x the tokens against a 1.14x cheaper blended price, so the cheap tiers worked and were swamped. Output tokens at 18.81x volume drove it.
- **A Haiku `scout` was actively harmful.** It generated 84 candidate findings a plain prompt never produced, and the verifier spent real money rejecting them.
- **The verifier was competent and still not worth it.** Over 418 leads it never dropped a true defect and rejected about three quarters of the bad ones. On the migration half, `node --test` surfaced every behaviour-breaking failure first, naming the file, while the verifier took 74.8% of the arm's cost and found nothing on top.
- **Sonnet as a mechanical executor held up.** 896 spawns changed 762 of 762 target files, touched 0 of 67 decoys, needed zero retries, and shipped untouched in 16 of 20 trials.
- **A simpler lever beats the plugin.** Stage 3, 180 trials: the same model at `low` effort cut cost per solved task **36.9%** for a 3.3-point pass-rate drop, and a Sonnet main session cut it **34.7%** and passed 3.3 points higher. The run's own noise floor reads 6.0%, so both clear it. Neither needs a plugin.

**Mode A's published number was an artefact, and is retracted.** The estimator compared a ratio of aggregate arm totals, letting a few expensive tasks decide the comparison. Against two operationally identical arms it read **-13.8%** where the true effect is zero by construction. The per-task paired estimator reads **-0.3%**, so mode A is **inconclusive**. Mode B's drop survives.

Two health warnings. Mode B audit tasks were scored against answer keys while six real defects sat on lines no key listed, so anything from that grader is a floor. And changing a pre-registered decision rule after reading results is what pre-registration exists to stop; it is declared at the top of the plan rather than buried.

**The harness, the plan, and the per-trial rows are not published.** Everything above is the author's report of his own results, not evidence you can check. The retraction is included for the same reason it was written, and is equally unverifiable from here.

## Why the pins are what they are

`mech-executor` is pinned to Sonnet because that pin is measured, and the "no open decisions left" bar is exactly what the measurement covers. On open-ended work the same tier fails expensively rather than cheaply.

`verifier` stays on `inherit` because adversarial checking is the one place you want the session's full capability, and inheriting keeps the checker from out-ranking the session that called it. Repricing it does not rescue the delegated arm: Sonnet is a uniform 0.40x of Opus across every token class, taking mode B from $170.00 to $102.31, still 3.8x a plain prompt. The cost was never the pin, it was the turn loop.

Three roles shipped in an earlier build and did not survive measurement:

- **`scout` (haiku).** Replaced by built-in `Explore`, which already inherits the session model capped at Opus. A pinned-cheap finder upstream of an expensive filter loses to not making the noise.
- **`security-executor` (opus).** The rationale was that cheaper models refuse benign defensive work more readily. That is backwards: frontier models carry the cyber classifiers, and Opus has been observed refusing *delegated* security tasks it accepts inline. Security work stays on the main thread.
- **`executor` (inherit).** Nothing measured supports handing open design decisions to a subagent at any tier, and `inherit` made it a strictly more expensive way to run the session model.

## What a plugin can't do

**Override the built-in `Explore`.** The override is scoped to a user or project subagent named `Explore`, and plugin agents are namespaced, so a plugin's own `Explore.md` registers as `kelpie:Explore` and nothing calls it. Built-in Explore inherits the session model capped at Opus, so the saving on offer is Opus to Haiku on background searches. To take it, add `~/.claude/agents/Explore.md`:

```markdown
---
name: Explore
description: Overrides the built-in Explore agent to run on Haiku.
model: haiku
---
```

Three more, for when something looks broken:

- **Setting your session model.** A plugin's bundled `settings.json` supports only `agent` and `subagentStatusLine`. Pinning your main session is a manual two-line addition to your own settings.
- **Calling its own agents by bare name.** In a workflow script, `agentType: 'mech-executor'` resolves against user and project agents only. The working form is `agentType: 'kelpie:mech-executor'`.
- **Surviving `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`** (v2.1.257+). It overrides *every* subagent's `model` field, kelpie roles and built-in Explore/Plan alike, forcing them onto `CLAUDE_CODE_SUBAGENT_MODEL`. Forks and skills run with `model: inherit` are the exceptions. If every role seems to run on one model despite correct frontmatter, check this first.

## Cost of installing it

From `claude plugin details kelpie` against 0.1.0. These are the CLI's estimates, not measured token accounting.

| Component | Always-on | On-invoke |
|---|---|---|
| `orchestration` skill | ~80 tok | ~2.4k tok |
| `kelpie:mech-executor` | ~140 tok | ~190 tok |
| `kelpie:verifier` | ~100 tok | ~450 tok |
| **Total always-on** | **~317 tok** | — |

Down from ~554 tok when five roles shipped: dropping three agents saved more than the rewritten policy skill added. The `delegation-triage` skill landed after that table and is not in it; its description is always-on like any other skill's, and the note its hook injects is about 130 tokens on a prompt that fires.

## What is still unknown

- **Whether delegation pays on work too large for one context.** Every trial fit comfortably in one. This is the case the remaining roles exist for, and it is untested.
- **Whether deciding per spawn beats deciding once.** The gate is the mechanism, Stage 4 is the experiment, and neither has produced a number.
- **Whether prompting the decision changes it.** Whether the triage turns into a spawn that pays, a spawn that wastes money, or no change at all is untested.

## Prior art

kelpie started as the orchestrator/executor split from [pilotfish](https://github.com/Nanako0129/pilotfish), whose own PR #43 measured delegation at 2.14x cost on a small task. Others covering similar ground: [moai-adk](https://github.com/modu-ai/moai-adk), [sous-chef](https://github.com/tomascupr/sous-chef), [frugal](https://github.com/ThomasLangbroek/frugal), [fable-baton](https://github.com/realgarit/fable-baton) (measured flat or higher total cost on its own 3-task comparison), [CoalTipple](https://github.com/TheColliery/CoalTipple).

The name is not clear in this space: `kelpie` is taken on npm, and an active cluster of GitHub repos uses it in the same niche. Kept and disclosed rather than hidden.

## License

MIT, see [LICENSE](LICENSE).
