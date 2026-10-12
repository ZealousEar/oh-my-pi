A Cua-Driver-backed action path needs every one of these before it can run a single step; none of them can be supplied by this agent.

- Cua Driver installed at `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`, on `PATH` as `cua-driver`, or pointed at by the `computer.driverBin` setting / `CUA_DRIVER_BIN` environment variable.
- Driver version 0.28.2 or newer: the per-call `target` + `element_token` action contract, the closed `effect`/`route` action result, and `permissions status --json` this integration reads are documented for that release.
- The driver daemon already running under the app's own identity (`cua-driver status` reporting `Cua Driver daemon is running`, started by the user with `open -n -g -a CuaDriver --args serve`). This agent never spawns, installs, or upgrades the daemon.
- macOS Accessibility and Screen Recording granted to `CuaDriver.app` itself (`cua-driver permissions grant`, then `cua-driver permissions status` showing both granted). The standard daemon refuses every tool call with `permissions_pending` until both grants exist.
- The daemon's MCP tool surface reachable through one-shot `cua-driver call <tool> '<json>'`: `list_windows`, `get_window_state` (accessibility tree without a screenshot), `click`, and `set_value`, addressed by `pid` + `window_id` and per-snapshot `element_token`s.

Until all of that holds, desktop goals run on the native accessibility backend (`computer.task.backend: auto`), or fail closed when `computer.task.backend` is `cua`.
