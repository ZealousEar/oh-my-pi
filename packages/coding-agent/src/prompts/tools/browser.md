Drive real Chromium tabs from JavaScript or Python Eval with the global `browser` object.

<instruction>
- Static content? Use `read`. Use `browser` for JavaScript execution, authenticated sessions, and interactive actions.
- JavaScript: `await browser.open(options)` returns a `BrowserTab`; `browser.tab(name)` returns an existing handle; `await browser.close(options)` releases tabs.
- Python: `await browser.open(name=…, url=…)`, synchronous `browser.tab(name)`, and `await browser.close(name=…)`. Python methods accept keyword arguments.
- `open` options: `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, `timeout`, `persist`.
- `close` options: `name`, `all`, `kill`, `timeout`.
- Direct tab helpers:
  - Navigation: `url`, `title`, `goto`.
  - Inspection: `observe`, `ariaSnapshot`, `screenshot`, `extract`.
  - Interaction: `click`, `type`, `fill`, `press`, `scroll`, `drag`, `scrollIntoView`, `select`, `uploadFile`.
  - Waiting: `waitFor`, `waitForSelector`, `waitForUrl`.
  - Page execution: `evaluate`. `tab.evaluate(string)` evaluates the string as a page-global expression; top-level `return` is invalid. Pass a function or invoke an IIFE string to use `return`.
- `tab.id(n)` / `tab.ref("e5")` return `BrowserElement` handles supporting `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.
- JavaScript `await tab.run(fnOrCode, { args?, timeout? })` runs a function or code string. Functions receive `{ tab, page, browser, wait, assert }`; cell closures are not captured. Plain data, functions, and `RegExp` values are supported in `args`.
- Python `await tab.run(code, timeout=…)` accepts a JavaScript code string only. Direct Python helpers use the same method names; keyword arguments become a trailing JavaScript options object.
- `tab.run` executes in an isolated JavaScript tab runtime with raw Puppeteer `page`/`browser`, ordinary Eval helpers, and full Bun/Node + tool-bridge access. It is not sandboxed.
- `await tab.task({ goal, values?, expect?, maxActions?, maxCalls?, timeout?, allowConsequential? })` runs a bounded goal-directed loop on that tab: one atomic control read per step, one typed judgment to pick an operation and its target, guarded input, then independent verification of the proposed completion. It returns `{ status, steps, verification, budget, usage, backend }` - `status: "done"` only when `expect` and the completion check both pass, otherwise `unverified`, `blocked`, `abstain`, `exhausted`, or `error`.
  - Supply `values` for anything you already know (`{ "Full name": "Ada" }`, matched by field label); a small model writes a value only when no supplied key matches, and never invents personal data.
  - Consequential controls (submit, buy, pay, purchase, checkout, place order, send, delete, remove, confirm, transfer, sign) are refused with `status: "blocked"` unless you pass `allowConsequential: true`.
  - `task` releases its tab when it finishes unless the tab was opened with `persist: true`. On a relay/CDP browser it refuses to run on a tab that adopted the user's visible foreground tab - open with `app.new_tab: true` (an omp-owned tab) or `app.target` naming a dedicated tab.
  - Canvas, file upload, frames, and shadow DOM are reported as unsupported and handed back rather than guessed; drive those with `observe` + explicit helpers.
- Direct helpers and `tab.run` return real structured values. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images.
- Selectors accept CSS plus Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers.
- Navigation and re-renders invalidate observed ids and refs. Re-observe, then act in the same cell.
- Use `tab.select` for `<select>` elements; `tab.fill` does not support them.
- Raw request interception lasts only for the current `tab.run`.

Permission policy:
- Use inspection helpers without a browser mutation capability. Navigation helpers are automatic only on lifecycle-owned tabs; adopted/non-owned tabs require an exact origin/action scope for goto, scroll, scrollIntoView, focus, and hover. Open an omp-owned tab for autonomous navigation.
- Obtain an exact, unexpired origin/action scope before each ordinary page mutation. Typed values are represented by fingerprints rather than plaintext.
- Treat `tab.run`, `evaluate`, and raw page/browser/CDP access as raw automation. Ordinary origin grants and `"*"` actions never cover raw execution. Raw execution requires either `rawAccess: "broad"` for the whole browser identity or a full SHA-256 entry in `codeFingerprints` for the exact dispatched source.
- Interactive raw approval states that arbitrary code reaches the whole relay browser identity, not only the current origin, and grants the exact code once or for 60 minutes. Headless callers receive `AUTOMATION_DENIED` unchanged so their owner can preconfigure `browser.permissions.grants`.
- Apply the same dispatch-specific rule inside `tab.task`: each selected mutation is authorized immediately before dispatch, and consequential operations require both `allowConsequential: true` and a consequential scope.

Application modes:
- Omit `app` for default automation; no executable path required. Managed Chromium installs automatically on first use.
- `app.path`: launch the specified browser or Electron executable. Chromium-family browsers use an omp-owned profile unless `args` supplies `--user-data-dir`.
- `app.cdp_url`: attach to an existing CDP endpoint.
- `app.relay: true`: drive the user's Chrome through the omp relay. `app.target` selects a tab by URL/title substring; without it, the visible tab is adopted. Opening with `url` navigates that adopted tab.
- `app.new_tab: true` (relay or `cdp_url`): create a fresh omp-owned tab instead of adopting one; the open result says `owned tab` vs `adopted tab`. The user's foreground tab is left in place. Mutually exclusive with `app.target`; rejected on headless/spawned browsers. Use it for `tab.task` and for any navigation the user did not ask for on their own tab.
- Relay sessions are the user's real logged-in browser. Sites attribute actions to the user. Name a target or create a dedicated tab with `app.new_tab`; NEVER navigate the visible tab without authorization.
- Closing releases the managed tab. It closes omp-owned tabs (`app.new_tab`) and never closes adopted relay/CDP pages. `kill: true` terminates only applications spawned by this process, never reused browser processes.
- Idle tabs auto-freeze at turn settle (animated pages stop burning CPU/GPU) and unfreeze on next use; tabs idle past the idle-close timeout are closed. Pass `persist: true` on `open` to keep a tab live across turns (e.g. multi-step login); `browser.close` still releases explicitly.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const observed = await tab.observe();
await tab.id(observed.elements[0].id).click();
const title = await tab.run(async ({ tab }, suffix) => (await tab.title()) + suffix, { args: ["!"] });
await tab.close();
```

```python
tab = await browser.open(name="docs", url="https://example.com")
observed = await tab.observe()
await tab.id(observed["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```
</examples>

<critical>
- MUST open a tab before direct use; `browser.tab(name)` does not open one.
- Default to `tab.observe()`; use screenshots for visual confirmation.
- `tab.run` has full Bun/Node and tool-bridge access; it is not sandboxed.
- Relay and CDP actions operate on real user sessions.
</critical>
