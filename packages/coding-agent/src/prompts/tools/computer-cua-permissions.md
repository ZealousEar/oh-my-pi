macOS attributes Accessibility and Screen Recording grants to `CuaDriver.app`, not to the terminal that runs this agent, so only the driver's own flow can grant them; no API call from here can.

{{#unless daemonRunning}}
1. Start the daemon through LaunchServices so the prompts attribute to the app: `open -n -g -a CuaDriver --args serve`
{{/unless}}
2. Run `cua-driver permissions grant`; it launches CuaDriver, raises the macOS prompts, and waits.
{{#if accessibility}}
   - Accessibility: the prompt offers "Open System Settings", not "Allow". Under Privacy & Security > Accessibility, switch CuaDriver on.
{{/if}}
{{#if screenRecording}}
   - Screen Recording: under Privacy & Security > Screen & System Audio Recording, switch CuaDriver on.
{{/if}}
3. Accept the offer to quit and reopen CuaDriver; a changed grant takes effect only after the app relaunches. If the daemon does not come back, rerun `open -n -g -a CuaDriver --args serve`.
4. Confirm with `cua-driver permissions status`; it reads the daemon's real grant state and reports `unknown` (never `granted`) while no daemon runs.

If CuaDriver is missing from either list, add `/Applications/CuaDriver.app` with the "+" button, enable it, and run `cua-driver permissions grant` again.
