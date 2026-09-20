---
name: delegation-triage
description: Turn kelpie's delegation triage on or off, or report its state. The triage is a UserPromptSubmit hook that checks every prompt and puts the delegate-or-not decision in front of the model; in prefer mode with a Jev key it asks about the prompt and names one route. Run only when the user asks to set it up, change its scope or mode, make delegation the default, stop prompts being sent to Jev, disable it, or check whether it is on.
---

The triage is a `UserPromptSubmit` hook kelpie already ships.
It is off until a config file turns it on, and this skill writes, reads, or removes that file.
Nothing else needs editing: no `settings.json` entry, no path that carries a version number in it.

**Say this once, before turning it on.**
The triage makes the *decision* the default, not delegation.
kelpie's own benchmark measured Opus 5 spawning a subagent zero times over 180 trials, and measured forced delegation at 6.37x the cost of a plain prompt for the same 100% pass rate.
The note the hook injects leads with "do it on the main thread", because on almost every prompt that is the right answer.
If the user wants the opposite, that is the `prefer` mode below, and it is a deliberate choice rather than the default one.

## What the modes do

| Mode | Behaviour |
|---|---|
| `signals` | Checks every prompt, injects the decision note only on prompts that score 2 or more. Breadth alone scores 2; repeated treatment, an independent check, and wide recon score 1 each. This is the mode to recommend |
| `always` | Injects on every prompt, one short line when nothing fired and the full note when something did. Costs context on every turn. Only if the user asks for it by name |
| `prefer` | The opt-in inversion. Injects a note that routes the work instead of arguing for the main thread. With a Jev API key configured it asks about the prompt and names one route; without a key it drops the bar to one signal and lists the routes |
| `off` | Emits nothing. Same as no config file |

Every mode stays silent on an empty prompt and on a prompt that starts with `/`, since a slash command carries its own instructions.

**Before writing `prefer`, say the number once.** It is the mode that costs money on purpose: kelpie's own benchmark measured forced delegation at 6.37x a plain prompt for the same 100% pass rate.
Say it in one line and then do what the user asked.
They are opting in, not asking to be talked out of it, so do not repeat the warning afterwards.
Even in this mode the note keeps two exclusions, because neither is a cost question: work with open design decisions in it, and security-sensitive work, both stay on the main thread.

With no Jev key, a prompt carrying no delegation signal at all stays silent in `prefer` too.
There is nothing to fan out on "fix the typo on line 40", and spawning for it is the 6.37x with none of the reason.
If a user wants a note on literally every prompt, that is `PREFER_THRESHOLD` in `hooks/delegation-triage/signals.mjs`, set to 0.

## prefer mode asks Jev about the prompt

With a Jev API key configured, `prefer` mode stops deciding from keywords and asks instead.
This is on by default in `prefer` mode, and only in `prefer` mode.

The keyword families can tell you whether a prompt is *shaped* like a fan-out.
They cannot tell you whether this job is cheaper split up, which is the question `prefer` mode exists to answer.
kelpie's own benchmark is the evidence: ten real tickets, `prefer` mode on, every one scoring zero on every family, so the note fired on none of them.
A bar low enough to catch those fires on every prompt instead. Neither setting of a keyword bar answers the question, because the question is not about the words.

So one call carries five questions about the work, and the answers pick a route:

| Answer | What it decides |
|---|---|
| `delegation_saves` | Whether splitting the work costs less than doing all of it in this session. This is the only thing that stops `prefer` mode delegating |
| `read_only` | Recon goes to the built-in `Explore` agent |
| `fully_specified` | An open decision is resolved in this session first, and what is handed out afterwards runs at the session's own model |
| `difficulty` | The model and effort: mechanical to haiku, moderate to sonnet at medium, hard to sonnet at high, hard and long to the session's own rung at xhigh |
| `long_horizon` | With `difficulty`, whether the result gets an independent `kelpie:verifier` check |

The note then names one route, one tier, and the answer behind it, rather than listing the options.

**Say these three things before turning it on with a key.**

- **Every prompt goes to a third party.** The text of each prompt the triage reads is POSTed to `api.typesafe.ai` before the turn starts. Not slash commands and not the notices Claude Code generates itself, but everything else.
- **Every turn waits for it.** Up to six seconds, two attempts. `KELPIE_TRIAGE_BUDGET_MS` and `KELPIE_TRIAGE_REQUEST_MS` set that.
- **It cannot fail a turn.** A timeout, an error, or an unsure answer on the question that decided the route leaves `prefer` mode saying exactly what it says with no key. An unsure `difficulty` costs the route its model and its review, not its agent, so the spawn inherits the session's model instead of the route being dropped.

`KELPIE_TRIAGE_CONSULT=off` keeps `prefer` mode on and keeps every prompt off the wire.
Write that for a user who wants `prefer` mode and has a key configured for the spawn gate but does not want their prompts sent.

The route never climbs above the session's own model.
On the first prompt of a session, before any assistant turn exists to read a model from, the route names no model at all, which inherits the session's.

## Scope

- **Project**: `<repo root>/.claude/kelpie-triage.json`. Wins over user scope. This is the right default, because the work the triage is for is one repo with more files than a context holds, not every repo the user opens.
- **User**: `$CLAUDE_CONFIG_DIR/kelpie-triage.json`, or `~/.claude/kelpie-triage.json` when that variable is unset.

`KELPIE_TRIAGE=off|signals|always|prefer` in the environment beats both files, and exists for a benchmark arm rather than for daily use.

`KELPIE_TRIAGE_THRESHOLD=<n>` overrides the score a prompt needs, for the same reason. `0` fires on every prompt the hook reads. It exists because a benchmark arm ran ten tickets in `prefer` mode and the note fired on none of them: real prompts often score zero, and a mode you cannot observe is a mode you cannot measure. Do not write it into a user's environment. Outside a measurement it buys the 6.37x with none of the reason.

## The log

A `"log": "<path>"` key in the same config file, or `KELPIE_LOG` in the environment, makes both hooks append one JSON line per decision to that path.

Write it when the user asks to see what the triage is doing, or when they are about to change mode and want to know what the current one decided.
Every decision is recorded, including the ones that emitted nothing, with `emitted`, `score`, `fired` and a `reason`.
A run of `emitted: false` on prompts the user expected to fire is the evidence for lowering the bar or changing mode; without it the answer is a guess.

Both sets of Jev calls go to the same file: what was sent, to where, how large it was, what came back.
A `prefer` mode decision that was routed also carries `decided_by`, the five answers, and the route, so a session can be read back as what kelpie told the model to do.

Prompt text and file excerpts stay out unless `KELPIE_LOG_PROMPTS=1` or `KELPIE_LOG_EXCERPTS=1` is set.
Do not set either in a user's config: the log then carries whatever they typed and whatever their repository holds.
Say so if they ask for it.

## Doing it

1. Read the arguments for a mode (`on`, `signals`, `always`, `prefer`, `off`, `status`) and a scope (`--project`, `--user`).
   `on` means `signals`.
   A user asking to delegate by default, or every time, means `prefer`.
   If the user gave a mode but no scope, use project scope and say so in one line rather than asking.
   If they gave neither, report status and stop.
2. For `status`: check the environment variable, then the project file, then the user file, in that order, and report the first one that names a mode, plus which source it came from.
   Say `off (no config)` when none exists.
3. For a mode: write the file, creating `.claude/` if it is missing.
   The whole file is one object:

   ```json
   {
     "mode": "signals"
   }
   ```

4. For `off`: prefer deleting the file over writing `{"mode": "off"}`, unless a user-scope file is on and the user wants this one project quiet, which is exactly what a project-scope `off` is for.
5. Confirm in one or two lines: the mode, the file path, and the scope it applies to.

## After writing it

The config file is read on each prompt, so a mode change takes effect on the next prompt with no restart.
The hook entry itself is registered when the session starts.
If kelpie was installed or upgraded to a version carrying this hook *during* this session, the file will do nothing until the session is restarted.
Tell the user that only if the plugin was in fact installed or upgraded mid-session.

To check the hook end to end without waiting for a prompt:

```
echo '{"hook_event_name":"UserPromptSubmit","cwd":"'"$PWD"'","prompt":"rename the old client across every service"}' \
  | node "$CLAUDE_PLUGIN_ROOT"/hooks/delegation-triage/triage.mjs
```

It prints one JSON object carrying `hookSpecificOutput.additionalContext` when the triage fires, and nothing at all when it does not.
`$CLAUDE_PLUGIN_ROOT` is set inside hook commands, not in an interactive shell, so substitute the plugin's install path when running this by hand.

## What it will not do

It does not rewrite the prompt.
It injects context and nothing else, so a wrong call by the triage costs a paragraph, never the user's wording.

In every mode but `prefer` with a key, it does not decide anything itself.
The note names what the prompt carries and restates the policy; the model still makes the call and should say which way it went in one line.
`prefer` mode with a key does name a route, and the model still owns the call: the note is context, not a command, and the model may say why it went another way.

It does not reach subagents.
`UserPromptSubmit` fires for the main thread only, which is the right place for this decision anyway.
