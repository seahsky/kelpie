# kelpie

A Claude Code plugin that decides **when delegating is worth it**, and what each spawn costs when it happens.

Named for the Australian working dog: the shepherd sets policy once, the dog directs, the flock does the moving.

Its own benchmark says delegate *less*, not more. The plugin is built around that result.

## Install

```
claude plugin marketplace add seahsky/kelpie
claude plugin install kelpie@kelpie
```

That gives you three roles, a policy skill, four workflow commands, and a delegation triage that checks every prompt in `prefer` mode.

Claude Code asks for two optional settings as it enables the plugin: a Jev API key, and whether to send prompts to Jev.
Prompts leave your machine only with both: a key, and "Send prompts to Jev" turned on.
Without them, the triage decides from keywords.
Read [the triage section](#with-jev-prefer-mode-asks-instead-of-guessing-from-keywords) before you turn it on.

To try it without installing anything:

```
claude --plugin-dir /path/to/kelpie
```

## What it ships

| Component | | For |
|---|---|---|
| `kelpie:recon` | haiku | Read-only lookups. Reports what the code says with `path:line`, never what is wrong with it |
| `kelpie:mech-executor` | sonnet, low | Fully-specified mechanical work. No open decisions left |
| `kelpie:verifier` | inherit, medium | Adversarial check of a claim **no executable check can settle** |
| [policy skill](skills/orchestration/SKILL.md) | ~80 tok always-on | When delegating pays, which role fits, when to run a check instead |
| [workflow scripts](workflows/) | 4 | `/kelpie:audit-many-files`, `/kelpie:fix-until-check-passes`, `/kelpie:migrate-in-parallel`, `/kelpie:review-and-merge-findings` |
| [delegation triage](hooks/delegation-triage/) | on, `prefer` mode | Checks every prompt for work a subagent on a cheaper model can do for less than your session |
| [spawn gate](hooks/jev-gate/) | off without a key | Decides model and effort per spawn instead of once. Needs an API key, and sends code off the machine |

Recon goes to `kelpie:recon` rather than Claude Code's built-in `Explore`, because `Explore` runs on your session's model.

## The delegation triage

A `UserPromptSubmit` hook reads each prompt and checks whether a subagent on a cheaper model can do the work for less than your session.
It exists because a policy skill only helps if the model reads it at the moment it matters, and measured over 180 trials it did not.

It runs in `prefer` mode unless you pick another mode with `/kelpie:delegation-triage`, per project or per user.
That writes one config file, so there is no `settings.json` entry to add and nothing to redo after an upgrade.

| Mode | What it does |
|---|---|
| `prefer` | The default. Hands work to a subagent on a cheaper model when the work is big enough to outrun the hand-off. Otherwise it says "do it here", or nothing |
| `signals` | A note that argues for the main thread, only on delegation-shaped prompts |
| `always` | That note on every prompt. Costs context every turn |
| `off` | Nothing. It has to be written, since no config file means `prefer` |

It never rewrites your prompt: it adds a paragraph of context and nothing else, 400 to 1,200 characters depending on the note.
A hook that fails, times out, or reads a payload it does not understand emits nothing, which leaves the prompt as you typed it.
A Jev call that fails does not silence the turn: the mode falls back to the note it would have shown with no key.

Two costs.
The hook starts a node process on every prompt.
And nothing measured supports it yet: whether routing work to a cheaper model saves money in practice has not been run.

### Why only cheaper models

A subagent on your session's own model pays for the hand-off and saves nothing on price.
That includes Claude Code's built-in `Explore`, which runs on your session's model, capped at Opus.
So `prefer` mode sends lookups to `kelpie:recon` on Haiku and fully-specified work to `kelpie:mech-executor` on Sonnet, or on Haiku for a pattern-only edit, and only when that model is below yours.
Where the cheapest model that fits is your own, it says to do the work here.

A cheaper model is not enough on its own.
Forcing delegation measured 6.37x a plain prompt at a 1.14x cheaper blended price, because the turn loop multiplied the tokens.
So the work also has to be big enough to outrun the hand-off: one grep is cheaper done in your session at any price.

### With Jev, prefer mode asks instead of guessing from keywords

On its own, `prefer` mode goes by keywords and speaks only on prompts that carry a delegation signal.
Give the plugin a Jev API key and turn on "Send prompts to Jev", and it sends the prompt instead, and gets back five answers about the work: whether it is big enough to hand over, whether it is read-only, whether anything is still undecided, how hard it is, and whether it is a long job.
kelpie then picks the cheapest model the work can stand and compares it with your session's model.

```
kelpie delegation triage (prefer mode), decided with jev: delegate this.

A subagent on sonnet costs less than doing this here: the work is big enough to outrun the
hand-off (substantial 0.9), and sonnet is enough for it.
- Resolve every open decision here first (fully_specified 0.2). Then hand over what is left.
- Spawn kelpie:mech-executor with model: sonnet: moderate (difficulty 1.1).
- Spec it in one shot: exact file paths, exact symbol names, acceptance criteria, and why the
  work matters. A subagent cannot ask you a question mid-task.
- Security-sensitive work stays in this session whatever this says. Opus has been observed
  refusing delegated security tasks that it accepts inline.
```

The route names a model and no effort, because the Agent tool takes a model and has no effort parameter.

On the first prompt of a session no hook can read your model: the transcript has no assistant turn yet, and no hook payload carries it.
The note then says which model your session has to be above to take the route, and the model decides, since it knows what it runs on.

Three things to know before you turn it on.

- **Every prompt goes to a third party**, before the turn starts. Not slash commands, and not the notices Claude Code generates itself, but everything else. A key alone sends no prompts: that takes the "Send prompts to Jev" option, which is off unless you turn it on. `KELPIE_TRIAGE_CONSULT=off` also keeps your prompts off the wire, whatever the option says.
- **Every turn waits for it**, up to six seconds over two attempts. `KELPIE_TRIAGE_BUDGET_MS` and `KELPIE_TRIAGE_REQUEST_MS` change that.
- **Nothing here can fail a turn.** A timeout, an error, or an unsure answer on a question that decides whether there is a route leaves `prefer` mode saying exactly what it says with no key. An unsure `difficulty` is read one level harder, so the route still arrives on a model that is safe to pick.

To set either after installing, run `/plugin configure kelpie@kelpie`.
"Send prompts to Jev" also appears in the `/config` panel; the key does not, because it is stored as a secret.
Keys come from [console.typesafe.ai/keys](https://console.typesafe.ai/keys).

This is the newest part of kelpie and the least measured.

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

The key does not send your prompts. The prompt consult described above needs the separate "Send prompts to Jev" option as well, which is off unless you turn it on.

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

`recon` is pinned to Haiku because recon on your own model saves nothing on price.
Its brief keeps it to lookups, and every fact it reports carries the `path:line` it came from.
Findings are ruled out, which is where the Haiku `scout` below went wrong.
Unlike the Sonnet pin, this one is not measured.

`mech-executor` is pinned to Sonnet because that pin is measured, and the "no open decisions left" bar is exactly what the measurement covers. On open-ended work the same tier fails expensively rather than cheaply.

`verifier` stays on `inherit` because adversarial checking is the one place you want the session's full capability, and inheriting keeps the checker from out-ranking the session that called it. Repricing it does not rescue the delegated arm: Sonnet is a uniform 0.40x of Opus across every token class, taking mode B from $170.00 to $102.31, still 3.8x a plain prompt. The cost was never the pin, it was the turn loop.

Three roles shipped in an earlier build and did not survive measurement:

- **`scout` (haiku).** It was asked to find problems, and a pinned-cheap finder upstream of an expensive filter loses to not making the noise. It came back as `recon`, on the same model with a brief that rules out findings, because the built-in `Explore` that replaced it runs on your session's model and so saves nothing on price.
- **`security-executor` (opus).** The rationale was that cheaper models refuse benign defensive work more readily. That is backwards: frontier models carry the cyber classifiers, and Opus has been observed refusing *delegated* security tasks it accepts inline. Security work stays on the main thread.
- **`executor` (inherit).** Nothing measured supports handing open design decisions to a subagent at any tier, and `inherit` made it a strictly more expensive way to run the session model.

## What a plugin can't do

**Override the built-in `Explore`.** The override is scoped to a user or project subagent named `Explore`, and plugin agents are namespaced, so a plugin's own `Explore.md` registers as `kelpie:Explore` and nothing calls it. Built-in Explore inherits the session model capped at Opus. kelpie routes its own lookups to `kelpie:recon` instead, but the model still picks `Explore` for searches kelpie's note did not route. To move those to Haiku too, add `~/.claude/agents/Explore.md`:

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

From `claude plugin details kelpie` against this version. These are the CLI's estimates, not measured token accounting.

| Component | Always-on | On-invoke |
|---|---|---|
| `delegation-triage` skill | ~160 tok | ~3.9k tok |
| `orchestration` skill | ~80 tok | ~3k tok |
| `kelpie:recon` | ~140 tok | ~460 tok |
| `kelpie:mech-executor` | ~150 tok | ~190 tok |
| `kelpie:verifier` | ~100 tok | ~460 tok |
| **Total always-on** | **~625 tok** | — |

The table does not count the note the triage hook injects, since that lands only on prompts where it fires.
The note runs 400 to 1,200 characters.

## What is still unknown

- **Whether delegation pays on work too large for one context.** Every trial fit comfortably in one. This is the case the remaining roles exist for, and it is untested.
- **Whether deciding per spawn beats deciding once.** The gate is the mechanism, Stage 4 is the experiment, and neither has produced a number.
- **Whether routing to a cheaper model pays.** `prefer` mode now routes work only to a model below your session's, and only when the work is big enough to outrun the hand-off. No run has measured that yet.

## Prior art

kelpie started as the orchestrator/executor split from [pilotfish](https://github.com/Nanako0129/pilotfish), whose own PR #43 measured delegation at 2.14x cost on a small task. Others covering similar ground: [moai-adk](https://github.com/modu-ai/moai-adk), [sous-chef](https://github.com/tomascupr/sous-chef), [frugal](https://github.com/ThomasLangbroek/frugal), [fable-baton](https://github.com/realgarit/fable-baton) (measured flat or higher total cost on its own 3-task comparison), [CoalTipple](https://github.com/TheColliery/CoalTipple).

The name is not clear in this space: `kelpie` is taken on npm, and an active cluster of GitHub repos uses it in the same niche. Kept and disclosed rather than hidden.

## License

MIT, see [LICENSE](LICENSE).
