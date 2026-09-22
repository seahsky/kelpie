---
name: delegation-triage
description: Change kelpie's delegation triage mode, turn it off, give it a Jev key, or report its state. The triage is a UserPromptSubmit hook that checks every prompt, in prefer mode by default, for work a subagent on a cheaper model can do for less; with a Jev key it asks about the prompt and names one route. Run only when the user asks to change its scope or mode, add or remove the Jev key, stop prompts being sent to Jev, disable it, or check whether it is on.
---

The triage is a `UserPromptSubmit` hook kelpie already ships.
It runs in `prefer` mode unless a config file names another mode, and this skill writes, reads, or edits that file.
Nothing else needs editing: no `settings.json` entry, no path that carries a version number in it.

## What the modes do

| Mode | Behaviour |
|---|---|
| `prefer` | The default. Routes work to a subagent on a cheaper model than the session when the work is big enough to outrun the hand-off, and says "do it here" when the cheapest model that fits is the session's own. With a Jev API key it asks about each prompt and names one route; without a key it goes by keywords at a bar of one signal |
| `signals` | Injects a note that argues for the main thread, only on prompts that score 2 or more. Breadth alone scores 2; repeated treatment, an independent check, and wide recon score 1 each |
| `always` | Injects on every prompt, one short line when nothing fired and the full note when something did. Costs context on every turn. Only if the user asks for it by name |
| `off` | Emits nothing. It has to be written: no config file now means `prefer` |

Every mode stays silent on an empty prompt, on a prompt that starts with `/`, and on the notices Claude Code submits itself.

**Why `prefer` delegates only downward in price.**
A subagent on the session's own model pays for the hand-off and saves nothing, so `prefer` never routes to one.
A cheaper model is not enough on its own either: kelpie's own benchmark measured forced delegation at 6.37x a plain prompt for the same 100% pass rate, at a 1.14x cheaper blended price, because the turn loop multiplied the tokens.
Hence the second condition, that the work is big enough to outrun the hand-off.
On most prompts the answer is still "do it here", or nothing at all.

Two exclusions hold in every mode, because neither is a cost question: work with open design decisions in it, and security-sensitive work, both stay on the main thread.

## prefer mode asks Jev about the prompt

With a Jev API key configured, `prefer` mode stops deciding from keywords and asks instead.
A keyword score can tell you whether a prompt is shaped like a fan-out.
It cannot tell you whether the job is big enough to hand over, or how cheap a model it can stand.

One call carries five questions about the work:

| Answer | What it decides |
|---|---|
| `substantial` | Whether the work is big enough to outrun the hand-off. Work that one or two steps finish stays here |
| `read_only` | Lookups go to `kelpie:recon`; everything else to `kelpie:mech-executor` |
| `fully_specified` | An open decision is resolved in this session first, and only what is left is handed over |
| `difficulty` | The cheapest model that fits: mechanical to Haiku, moderate and hard to Sonnet, hard and long to the top model the session allows |
| `long_horizon` | With `difficulty`, whether the result gets an independent `kelpie:verifier` check |

The hook then compares that model with the session's own.
Same model or above: the note says to do the work here.
Cheaper: the note names the agent and the `model` to pass, and nothing else.
It names no effort, because the Agent tool takes a model and has no effort parameter.

On the first prompt of a session the hook cannot read the session's model: the transcript has no assistant turn yet, and no hook payload carries it.
The note then says which model the session has to be above to take the route, and the model decides, since it knows what it runs on.

**Say these three things before a user gives it a key.**

- **Every prompt goes to a third party.** The text of each prompt the triage reads is POSTed to `api.typesafe.ai` before the turn starts. Not slash commands and not the notices Claude Code generates itself, but everything else.
- **Every turn waits for it.** Up to six seconds, two attempts. `KELPIE_TRIAGE_BUDGET_MS` and `KELPIE_TRIAGE_REQUEST_MS` set that.
- **It cannot fail a turn.** A timeout, an error, or an unsure answer on a question that decides whether there is a route leaves `prefer` mode saying exactly what it says with no key. An unsure `difficulty` is read one level harder and drops the review, so the route still arrives.

`KELPIE_TRIAGE_CONSULT=off` keeps `prefer` mode on and keeps every prompt off the wire.
Write that for a user who has a key configured for the spawn gate but does not want their prompts sent.

## The key

Claude Code asks for the key when it enables the plugin.
A user who skipped that prompt, or wants to change the key, runs `/plugin`, opens kelpie, and uses its configure flow.
A user installing from a shell can pass it on the install line instead, `claude plugin install kelpie@kelpie --config jev_api_key=THEIR_KEY`, which puts the key in shell history, so say so.

Keys come from `console.typesafe.ai/keys`.
The hook reads the key from its environment, which is built when the session starts, so a new key takes effect in the next session.

Never ask the user to paste the key into this conversation, and never write it into a config file, a settings file, or the environment.
A key typed into the chat lands in the transcript.
The plugin option stores it in the macOS Keychain, or in `~/.claude/.credentials.json` where no keychain is available or the Keychain refuses the write.

## Scope

- **Project**: `<repo root>/.claude/kelpie-triage.json`. Wins over user scope.
- **User**: `$CLAUDE_CONFIG_DIR/kelpie-triage.json`, or `~/.claude/kelpie-triage.json` when that variable is unset.

`KELPIE_TRIAGE=off|signals|always|prefer` in the environment beats both files, and exists for a benchmark arm rather than for daily use.

`KELPIE_TRIAGE_THRESHOLD=<n>` overrides the score a prompt needs, for the same reason. `0` fires on every prompt the hook reads. It exists because a benchmark arm ran ten tickets in `prefer` mode and the note fired on none of them: real prompts often score zero, and a mode you cannot observe is a mode you cannot measure. Do not write it into a user's environment.

## The log

A `"log": "<path>"` key in the same config file, or `KELPIE_LOG` in the environment, makes both hooks append one JSON line per decision to that path.

Write it when the user asks to see what the triage is doing, or when they are about to change mode and want to know what the current one decided.
Every decision is recorded, including the ones that emitted nothing, with `emitted`, `score`, `fired` and a `reason`.
A run of `emitted: false` on prompts the user expected to fire is the evidence for changing mode; without it the answer is a guess.

Both sets of Jev calls go to the same file: what was sent, to where, how large it was, what came back.
A routed `prefer` mode prompt writes two lines to read together: `jev_decision` carries the five answers, the session model, and the route they produced, and the `decision` line after it carries `decided_by` and a summary of that route.

Prompt text and file excerpts stay out unless `KELPIE_LOG_PROMPTS=1` or `KELPIE_LOG_EXCERPTS=1` is set.
Do not set either in a user's config: the log then carries whatever they typed and whatever their repository holds.
Say so if they ask for it.

Without them the log holds lengths and a truncated unkeyed SHA-256.
That is enough to tell two prompts apart, and enough for anyone holding the log to confirm a guess at a short prompt.
If the user asks whether the log is safe to share, say that it carries no prompt text and is still not anonymous.

## Doing it

1. Read the arguments for a mode (`prefer`, `signals`, `always`, `off`, `status`) and a scope (`--project`, `--user`).
   `on` means `prefer`, the default.
   If the user gave a mode but no scope, use project scope and say so in one line rather than asking.
   If they gave neither, report status and stop.
   If they asked about the key, follow "The key" above and stop.
2. For `status`: check the environment variable, then the project file, then the user file, in that order, and report the first one that names a mode, plus which source it came from.
   Say `prefer (default, no config)` when none exists.
3. For a mode: read the file at the chosen path first, then write it back with `mode` set and every other key kept.
   The file also holds `log`, so writing `{"mode": ...}` over it turns off logging the user asked for.
   Create the parent directory if it is missing, and take it from the path you resolved rather than assuming `.claude/`: user scope is `$CLAUDE_CONFIG_DIR/kelpie-triage.json` when that variable is set, which is not inside the project at all.
   A file that holds only a mode is one object:

   ```json
   {
     "mode": "off"
   }
   ```

4. For `off`: write `{"mode": "off"}` into the object as in step 3.
   Never delete the file to turn the triage off: no file means `prefer`.
   A project-scope `off` is also the way to keep one repo quiet while a user-scope mode stays on.
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
With a key in that shell's environment, the command sends the prompt to Jev like a real turn would.

## What it will not do

It does not rewrite the prompt.
It injects context and nothing else, so a wrong call by the triage costs a paragraph, never the user's wording.

In every mode but `prefer` with a key, it does not decide anything itself.
The note names what the prompt carries and restates the policy; the model still makes the call and should say which way it went in one line.
`prefer` mode with a key does name a route, and the model still owns the call: the note is context, not a command, and the model may say why it went another way.

It does not reach subagents.
`UserPromptSubmit` fires for the main thread only, which is the right place for this decision anyway.
