Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results; timeout unchanged.{{/if}}
`timeout: 0` drops only the per-call deadline; the session wall-clock cap (`tools.wallCapMs`) still bounds every call.
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready/env/lifetime require name; no async/timeout. env adds variables; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s. `lifetime` (seconds) bounds a finite run: the process tree is stopped when the total lifetime elapses, counted across restarts, and `proc://<name>` reports `lifetime of Ns expired`; omit only for genuinely open-ended services.{{/if}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
