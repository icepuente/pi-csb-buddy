# pi-csb-buddy

A [pi](https://github.com/earendil-works/pi) extension that reports the presence and activity of
pi sessions using the [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) provider,
so a desktop companion (buddy) can animate along with them.

## Install

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
|---|---|
| `idle` | Session started, nothing run yet |
| `thinking` | Turn started, thinking stream, between tool calls, or compacting |
| `active` | Text or tool-call streaming, or a tool is executing |
| `awaiting_approval` | A UI prompt is open |
| `waiting` | The agent run settled |
| `error` | A tool failed or the provider returned an error |
| `limit` | The provider error looked like a rate or usage limit |

Only provider error metadata is inspected, never assistant text or tool output. Write failures
are swallowed so the buddy can never interrupt a session.

## License

MIT
