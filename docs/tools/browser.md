# Browser Eval prelude

The Eval `browser` facade opens, reuses, scripts, and closes named Chromium, Electron, CDP, relay, or cmux tabs. Use [`read`](./read.md) for static URLs; use `browser` for authenticated state, JavaScript execution, or interaction.

## Source

- Host facade: `packages/coding-agent/src/tools/browser.ts`
- JavaScript/Python facades: `packages/coding-agent/src/tools/browser/prelude.{js,py}`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`
- Tab lifecycle: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Browser worker and inner tab API: `packages/coding-agent/src/tools/browser/tab-worker.ts`
- Browser registry and launch modes: `packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts`
- Relay: `packages/coding-agent/src/tools/browser/relay/`
- Cmux backend: `packages/coding-agent/src/tools/browser/cmux/`

The prelude exists only while Eval and `browser.enabled` are enabled. It is not an AgentTool.

## JavaScript API

```js
const tab = await browser.open({
  name: "main",
  url: "https://example.com",
  wait_until: "load",
});

const observation = await tab.observe();
await tab.id(observation.elements[0].id).click();
const title = await tab.title();

const length = await tab.run(
  async ({ tab }, suffix) => (await tab.title() + suffix).length,
  { args: ["!"], timeout: 30 },
);

await tab.close();
```

- `browser.open(options?) -> Promise<BrowserTab>` opens or reuses a named tab and returns its handle.
- `browser.tab(name = "main") -> BrowserTab` returns an existing handle; it does not open a tab.
- `browser.close({ name?, all?, kill?, timeout? }) -> Promise<void>` releases one or all managed tabs.
- `tab.close({ kill?, timeout? }) -> Promise<void>` releases that handle's tab.

`open` accepts `name`, `url`, `viewport`, `wait_until`, `dialogs`, `app`, `persist`, and `timeout`. `timeout` is in seconds, defaults to 30, and is clamped to 1–300. `app` selects the browser (`path`, `cdp_url`, `relay`, `args`, `target`, `new_tab`; see [Browser modes](#browser-modes)).

### Direct tab helpers

Direct helpers cross the host bridge and return real structured values:

- Navigation: `url()`, `title()`, `goto(url, { waitUntil? })`
- Inspection: `observe({ includeAll?, viewportOnly? })`, `ariaSnapshot(selector?, { depth?, boxes? })`, `screenshot({ selector?, fullPage?, silent? })`, `extract("markdown" | "text")`
- Interaction: `click(selector)`, `type(selector, text)`, `fill(selector, value)`, `press(key, { selector? })`, `scroll(dx, dy)`, `drag(from, to)`, `scrollIntoView(selector)`, `select(selector, ...values)`, `uploadFile(selector, ...paths)`
- Waiting: `waitFor(selector, { timeout? })`, `waitForSelector(selector, { timeout?, visible?, hidden? })`, `waitForUrl(stringOrRegExp, { timeout? })`
- Page execution: `evaluate(fnOrSource, ...args)`

Direct `waitFor` and `waitForSelector` return booleans. `tab.id(number)` and `tab.ref("e5")` instead return `BrowserElement` handles. Handles support `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.

Selectors accept CSS and Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers. Playwright-only pseudos such as `:has-text()` and `:visible` are rejected. `tab.select` is required for `<select>` elements; `tab.fill` does not support them.

`observe()` assigns numeric ids consumed by `tab.id`. `ariaSnapshot()` assigns `[ref=eN]` ids consumed by `tab.ref`. Navigation and re-rendering invalidate handles; re-observe and act in the same Eval cell.

### `tab.run(fnOrCode, options?)`

A run accepts either a serialized function or a JavaScript function-body string, plus `{ args?, timeout? }`:

```js
const hrefs = await tab.run(async ({ page }) => {
  return await page.$$eval("a", links => links.map(link => link.href));
});

const title = await tab.run(
  "return await tab.title();",
  { timeout: 10 },
);
```

Functions receive `{ tab, page, browser, wait, assert }` as their first argument. Additional `args` follow it. Plain data, functions, and `RegExp` values are serialized; the function cannot capture Eval-cell closures. Code strings use the same names as globals and allow top-level `await`.

The inner `tab` is the full worker helper API. In addition to the direct surface it includes handle-returning `waitFor`/`waitForSelector` and run-scoped `waitForNavigation`/`waitForResponse`. Start a navigation/response wait before the action that triggers it.

Runs use the shared JavaScript runtime with ordinary Eval helpers and full Bun/Node and tool-bridge access. This is API isolation, not a security sandbox. Request interception is cleaned up at the end of each run.

The return value stays structured. Nonempty text emitted by inner `display(...)` calls prints in the outer Eval cell, object/image displays remain Eval output, and a run with no display text emits no placeholder.

### `tab.task(options)` — goal-directed page loop

`await tab.task({ goal, values?, expect?, maxActions?, maxCalls?, timeout?, allowConsequential? })` drives a page toward a stated goal without hand-written selectors. Each step is: one atomic read of every visible control (role, accessible name, visible text, value/checked/expanded, enablement, occlusion, viewport, native `<select>` options) from a single `page.evaluate`; one typed judgment that picks an operation and its target from that local table (an id the judge did not receive is an error, never an action); guarded input that re-checks the document state and the target's identity, visibility, enablement and occlusion immediately before sending (SCROLL and WAIT are bound to the document too); then, when the judge proposes completion, a fresh observation checked against `expect` (`urlIncludes`, `textIncludes`, `selector`) plus a goal-satisfied judgment.

- Result: `{ status, steps, verification, budget, usage, attempts, backend, unusedValues?, quarantined? }`. `status` is `done` only when at least one caller `expect` check held on the fresh page and the completion judgment agreed; with no `expect` the best status is `unverified` (`verification.verified` is `"unknown"`, and `verification.detail` says whether the page changed at all since the task started) — the completion judgment comes from the same model family that proposed DONE and is never sufficient on its own. Otherwise `unverified` names the failed check, `blocked` (consequential control refused, repeated stale targets, or no progress), `abstain` (unsupported widgets such as canvas, file inputs, frames or shadow DOM), `exhausted` (bounds spent), or `error`. Every step carries compact provenance; `attempts` lists every remote attempt the task made (judgments, failed transport attempts behind a fallback, text-helper completions) with backend, model, usage, cost and error, and `usage.attempts` counts them beside `usage.calls`.
- `values` supplies known field values keyed by the field's label, placeholder, or form `name` (`{ "Full name": "Ada" }`). A key is used only when it equals one of those exactly after folding case, whitespace, and Unicode compatibility forms — a page label that merely contains the key (`Billing email backup collector` for `Billing email`) never receives the value. Keys that matched nothing are reported in `unusedValues` and are never typed. Fields with no matching value go to the small-model text helper, whose answer must be grounded: it declares `source: "values"` (then it must equal a caller value exactly) or `source: "goal"` (then the goal text must name the field's label); anything else is rejected as `helper value not grounded`. The loop never invents personal data.
- Stale targets (the node or document changed between observation and action) are re-observed, not retried blindly. A navigation or destroyed context during input yields an `unknown` outcome: the loop re-observes, records the action under `quarantined`, tells the judge, and does not offer it again — unless a caller `expect` check is still unmet on a changed document and the action is non-consequential.
- Consequential controls are refused unless `allowConsequential: true` (or `browser.task.allowConsequential`). Classification reads every name a control carries — accessible name, visible text, `aria-label`, `title`, and for a native select the chosen option's text — after NFKC normalisation, against: submit, buy, pay, payment, purchase, checkout, place order, order now, send, delete, remove, confirm, transfer, sign, authorize, approve, accept, agree, unsubscribe, cancel subscription, close account, publish, post, share, upload, save changes, don't save, discard, replace, overwrite, reset, revoke, disconnect, log out, sign out, subscribe, donate, tip, withdraw, deposit. A name whose letters mix writing systems (a Cyrillic `а` in `Pаy now`) fails closed as `unreadable label`. The refusing step's `reason` states which keyword matched in which source.
- Bounds come from `browser.task.maxActions`, `browser.task.maxCalls`, and `browser.task.deadlineSec`; a per-call `maxActions`/`maxCalls` can only tighten them. `maxCalls` counts text-helper completions as well as judgments. The deadline is checked before every page contact (observe, freshness check, probe, action) and every remote call, and each contact runs under a signal that fires at the deadline, so no step outlives the task.
- What leaves the machine: each judgment request carries the page origin and path (never query string or fragment), the title, up to 3000 characters of visible text, and one row per control with role, label, visible text when it differs, placeholder, state, and `filled: true|false` — field values themselves are not sent. The action ledger carries operation, label and outcome, never typed text. A text-helper request additionally carries the target field's own current value (capped at 200 characters), up to 2000 characters of visible text, and the caller `values` it may choose from. No screenshots or geometry are sent.
- Question design (TypeSafe skill-suggestion/fan-out shape): each step is ONE judgment request holding an `operation` Choice (only operations with at least one locally derived target are offered, plus WAIT/DONE/BLOCKED/ABSTAIN with rubrics) and one speculative `<op>_target` Choice per offered operation. Every target head states its premise in its own text ("Assuming the operation executed next on this page is CLICK …, which offered control …"), is answered without seeing the operation head, and carries a `none` option ("No offered control would advance the goal if CLICK ran next"); the loop takes the highest-ranked operation whose target head did not answer `none` (WAIT/DONE/BLOCKED/ABSTAIN have no target head and cannot be declined), and a veto is recorded on the step's `reason`. Instructions reference the state by path (`` `elements` ``, `` `filled` ``, `` `state` ``, `` `page.text` ``, `` `recent_actions` ``, `` `quarantined` ``). A proposed DONE re-observes and asks the `goal_satisfied` Noul — a yes/no question with `true`/`false` criteria — in its own request over the fresh page; `done` needs a caller `expect` check to hold **and** `goal_satisfied ≥ 0.5` (a code constant), and Choice `confidence` is recorded in provenance only, never used to authorise an action.
- On relay/CDP browsers the loop refuses a tab that adopted the user's visible foreground page; open with `app.new_tab: true` (an omp-owned tab) or `app.target` naming a dedicated tab.

Python: `await tab.task("goal", values={...}, expect={...}, allowConsequential=False)`.

## Python API

Python exposes the same handles and direct method names. `open` and `close` use keyword arguments, while `browser.tab` and `tab.id`/`tab.ref` are synchronous handle lookups. Keyword arguments on direct helpers become a trailing JavaScript options object.

```python
tab = await browser.open(name="main", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
await tab.id(observation["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```

Python `tab.run` accepts a JavaScript string only; it does not accept a Python callable.

## Browser modes

`browser.open` selects a browser in this order when explicitly requested: `app.cdp_url`, `app.path`, then `app.relay`. Without explicit selection it considers relay settings, configured CDP, cmux, then project-shared headless Chromium.

- **Headless:** creates an omp-owned page in project-shared Chromium and applies stealth patches.
- **Spawned (`app.path`):** starts or reuses a CDP-enabled browser/Electron executable. `app.args` applies only here.
- **Connected (`app.cdp_url`):** attaches to an existing HTTP CDP discovery endpoint and adopts one of its pages (`app.target` selects; otherwise the visible usable page).
- **Relay (`app.relay: true`):** adopts the user's real Chrome tab. `app.target` selects by URL/title substring; without it the visible usable tab is adopted.
- **Cmux:** drives an available cmux WKWebView surface.

### Owned versus adopted tabs on relay and connected browsers

An adopted tab belongs to the user: `open` navigates it only when `url` is given, `tab.task` refuses to drive it when it is the visible foreground tab, and closing releases omp's handle without closing the page.

`app.new_tab: true` (relay and `cdp_url` only) instead creates a fresh page target that omp owns: the open result reads `Opened tab "…" on relay … (owned tab)` (adopted opens read `(adopted tab)`, and the host result's `details.owned` carries the same flag), the target is created in the background and left unfocused, `url` is the only navigation it performs, `tab.task` accepts it, and `browser.close` (single or `all`) closes the tab. Reusing a name that currently holds an adopted tab with `new_tab: true` releases the adopted tab (without closing it) and creates an owned one. `new_tab` is rejected together with `app.target`, and on headless or spawned browsers, before any browser is launched or connected. Idle-close and turn-settle freezing apply only to headless tabs, as before.

Relay daemons from omp 18.1.x (`omp browser-relay` of that release, or its extension build) do not honor the background flag: Chrome activates the new tab, and omp immediately re-activates the tab the user had in front once it observes it hidden. Expect a brief flash of the new tab on those daemons; a daemon and extension from this build create it in the background outright.

Reusing one tab name across browser kinds is rejected until the existing tab is closed. Closing omp-owned headless pages, owned relay/connected tabs, and owned cmux surfaces closes them. Adopted connected and relay pages remain open. Spawned browser processes remain open unless `kill: true` releases their last managed tab and terminates the process.

## Screenshots and output

`tab.screenshot()` saves a full-resolution image beneath `browser.screenshotDir`, or the OS temporary directory when unset, and returns the path. Unless `silent: true`, it also emits an Eval image. It never accepts an output path.

Host result details preserve structured `value` separately from displayed content. Display text is capped by the shared inline-output policy; over-cap text is stored as a session artifact and the capped text is printed.

## Safety and lifecycle

Relay and attached modes operate on real logged-in sessions; sites attribute actions to the user. Name a target or create a dedicated tab with `app.new_tab`. Never navigate the user's visible tab or take a consequential action without direct authorization.

Each named tab has one worker and permits one active run. A timed-out or aborted run can recycle the worker and invalidate handles. `browser.close({ all: true })` releases all managed tabs; `kill` never closes or kills relay/CDP-attached browsers.

## Common recovery

- Missing/dead tab: call `browser.open` again.
- Stale id/ref: call `observe` or `ariaSnapshot` again, then reacquire the handle.
- Busy tab: await the active helper/run before issuing another.
- Selector timeout: re-observe and use a supported selector.
- Relay unavailable: install/start the relay and verify its Chrome extension connection.
- Attached target missing: inspect available pages and use a precise `app.target`.

`tab.run` and direct helpers execute against live browser state. Verify the actual page after every UI-changing action.
