# pi-csb-buddy

A [pi](https://github.com/earendil-works/pi) extension that reports the presence and activity of
pi sessions using the [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) provider,
so a desktop companion (buddy) can animate along with them.

## Install

```bash
pi install npm:pi-csb-buddy
```

Or straight from GitHub:

```bash
pi install git:github.com/icepuente/pi-csb-buddy
```

## How it works

While a TUI or RPC session has the `claude-bridge` provider selected, the extension writes
`<pid>.json` to `~/.claude/csb_pi_sessions/` (override with `CSB_PI_BUDDY_DIR`) on every state
change and every 5 seconds as a heartbeat. The file is removed when the session ends or another
provider is selected. Print-mode runs and subagents (`PI_SUBAGENT_CHILD=1`) are ignored.

```json
{ "version": 1, "pid": 1234, "provider": "claude-bridge",
  "updated_at": 1760000000.0, "state": "active", "activity_at": 1760000000.0 }
```

| State | When |
| --- | --- |
| `idle` | Session started, nothing run yet |
| `thinking` | Turn started, thinking stream, between tool calls, or compacting |
| `active` | Text or tool-call streaming, or a tool is executing |
| `awaiting_approval` | A UI prompt is open |
| `waiting` | The agent run settled |
| `error` | A tool failed (held until its whole parallel batch ends) or the provider returned an error |
| `limit` | The provider error looked like a rate or usage limit |

Any blocking `ctx.ui` prompt counts as `awaiting_approval`, including custom dialogs. Questions
from [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
show this way with no extra setup (tested with pi 1.3.0).

Only provider error metadata is inspected, never assistant text or tool output. Write failures
are swallowed so the buddy can never interrupt a session.

### Known limitation

The extension only sees pi's core tool events. A bash tool that hands a long command off to a
background job ends its tool call immediately, so the buddy shows `thinking` while the job is
still running.

## Development

```bash
npm install
npm run typecheck
```

## Releasing

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry, and commit.
2. Run `npm publish` from an interactive terminal. `prepublishOnly` runs the typecheck first, and
   npm asks for a browser 2FA check, so a non-interactive shell fails with `EOTP`.
3. If npm stages the release instead of publishing it, approve it in the **Staged Packages** tab on
   npmjs.com or with `npm stage approve <stage-id>`. Approval needs 2FA. A brand-new package
   shows a placeholder `0.0.0-stage` version until then.
4. Confirm with `npm view pi-csb-buddy version`, then tag and push:
   `git tag vX.Y.Z && git push origin main vX.Y.Z`.

## License

MIT
