Persistent bash 5.3.
cwd will reset after each turn, don't rely on cd; `pty` = interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s).
{{/if}}
`timeout: 0` drops only the per-call deadline; the session wall-clock cap (`tools.wallCapMs`) still bounds every call.
Don't trunc output by habit, result will be summarized and saved as an artifact.
{{#if hasLaunch}}
Long-lived services:
- unique name; ready/lifetime require name; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
- `lifetime` (seconds) bounds a finite run: the process tree is stopped when the total lifetime elapses, counted across restarts, and `proc://<name>` reports `lifetime of Ns expired`; omit only for genuinely open-ended services.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
