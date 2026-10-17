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
| `awaiting_approval` | A UI prompt is open, or the run settled on a reply that asks you something |
| `waiting` | The agent run settled, with no background job left to wake it |
| `error` | A tool failed (held until its whole parallel batch ends) or the provider returned an error |
| `limit` | The provider error looked like a rate or usage limit |

Any blocking `ctx.ui` prompt counts as `awaiting_approval`, including custom dialogs. Questions
from [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
show this way with no extra setup (tested with pi 1.3.0).

A settled run also shows `awaiting_approval` when the last assistant reply has a heading or line
starting with "Decision" / "Decisions", or ends with a question mark. It stays until you send your
next message.

Tool output is never inspected. Provider error metadata is checked for the error and limit states,
and assistant text only for the question check above. Only a yes/no result is kept; no text is
stored or written out. Write failures are swallowed so the buddy can never interrupt a session.

### Background jobs

With [`pi-job-listener`](https://github.com/xAndreiLi/pi-job-listener), a long bash command becomes
a background job and the agent is woken when it exits or goes quiet. A run that settles while such a
job will still wake the agent shows `active` rather than `waiting`, so the done animation only plays
once nothing is left to come back to.

A job that went quiet and has already been reported to the agent, such as a dev server, stops
counting: the buddy shows `waiting` while it keeps serving. It counts again if it prints more
output, since that leads to another wake.

The extension reads only the `job_id`, `log_path` and `detached` fields of the bash result, the
`stalled`/`terminal`/`wake` entries of pi-job-listener's `events.jsonl`, and the job log's
modification time. Job output is never read. Without pi-job-listener nothing changes.

### Known limitations

- A build that stays quiet past its `stall_seconds` looks like a parked dev server once its quiet
  report has been answered, so the buddy shows `waiting` until the build's exit wakes the agent.
  Raising `stall_seconds` for quiet builds avoids this.
- While a run is still going, the buddy shows `thinking` between tool calls even if a background
  job is running.

## Development

```bash
npm install
npm run typecheck
npm test
```

`npm test` runs three layers, with no model calls and only throwaway directories:

- `test/buddy.test.ts`: the buddy alone, against a hand-written pi-job-listener event log, with
  the heartbeat on mocked timers.
- `test/job-listener.test.ts`: the buddy next to the real `pi-job-listener` (pinned in
  `devDependencies`) in a fake pi host, running real background processes.
- `test/e2e.test.ts`: real pi (the pinned `@earendil-works/pi-coding-agent`) in RPC mode with both
  extensions, a scripted model registered as `claude-bridge`, and a recorder extension that reads
  the buddy's state after every handler, so even a momentary `waiting` is caught.

The suite takes about 40 seconds; most of it is real jobs running and going quiet.

## Releasing

Add changes under `## Unreleased` in `CHANGELOG.md` as you go. Then, on an up-to-date `main`:

```bash
npm run release -- patch --dry-run   # checks and tests only; writes nothing
npm run release -- patch             # or minor, major, or an exact x.y.z
```

The script checks the tree is clean and in sync with `origin/main`, runs the typecheck and tests,
moves the Unreleased entries under the new version and date, bumps `package.json`, commits, tags
`vX.Y.Z`, and pushes `main` and the tag together. The tag starts
[`.github/workflows/release.yml`](.github/workflows/release.yml), which runs the tests again,
publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (no
token, no OTP, provenance included), and creates the GitHub release from the CHANGELOG section.
The script watches that run with `gh` and finishes once npm shows the new version.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the typecheck and tests on Linux and
Windows for every push to `main`.

**One-time setup** on npmjs.com, under the package's **Settings → Trusted publishing**: add a
GitHub Actions publisher with organization `icepuente`, repository `pi-csb-buddy`, and workflow
`release.yml`, and select **Allow npm publish**. Without that option a trusted publisher may only
stage releases, and each one waits for approval with 2FA in the **Staged Packages** tab.

## License

MIT
