# ompd fork stack (fork/stack-18.6.1 on v18.6.1)

Final tree == 33ed76aea5. Built file-level from the squashed port; settings.ts/docs/settings.md split in two steps (core = pre-presets 925ffc71f6 version, presets = final). Other shared files (main.ts, settings modules, rpc wire, judgment) live wholesale in the core commit. Intermediate commits NOT type-checked.

## 1024dcb0fa feat(core): fork settings modules, judgment engine and shared plumbing
Per-feature settings modules (exec/extensibility/tools/task/browser/context settings)
split out of config/settings.ts, the judgment decision engine (judgment/*),
launch broker/service lifetimes, RPC wire + SDK additions, dirs helpers and
entrypoint wiring in main.ts. Shared files here carry hunks used by later
feature commits because the squashed port could not be split per hunk safely.
Must-keep: base for every later commit.

Files:
- docs/settings.md
- packages/coding-agent/src/config/settings.ts
- packages/coding-agent/src/discovery/helpers.ts
- packages/coding-agent/src/exec/settings.ts
- packages/coding-agent/src/extensibility/custom-tools/types.ts
- packages/coding-agent/src/extensibility/settings.ts
- packages/coding-agent/src/extensibility/shared-events.ts
- packages/coding-agent/src/judgment/decision.ts
- packages/coding-agent/src/judgment/index.ts
- packages/coding-agent/src/launch/broker.ts
- packages/coding-agent/src/launch/protocol.ts
- packages/coding-agent/src/launch/services.ts
- packages/coding-agent/src/main.ts
- packages/coding-agent/src/modes/controllers/event-controller.ts
- packages/coding-agent/src/modes/rpc/wire/events.ts
- packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts
- packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json
- packages/coding-agent/src/session/context-settings.ts
- packages/coding-agent/src/task/settings.ts
- packages/coding-agent/src/tools/approval.ts
- packages/coding-agent/src/tools/browser/settings.ts
- packages/coding-agent/src/tools/builtin-names.ts
- packages/coding-agent/src/tools/index.ts
- packages/coding-agent/src/tools/output-meta.ts
- packages/coding-agent/src/tools/read-pdf.ts
- packages/coding-agent/src/tools/settings.ts
- packages/coding-agent/src/tools/tool-timeouts.ts
- packages/coding-agent/test/config/fork-settings.test.ts
- packages/coding-agent/test/config/legacy-judgment-migration.test.ts
- packages/coding-agent/test/cursor-exec.test.ts
- packages/coding-agent/test/discovery/agent-fields.test.ts
- packages/coding-agent/test/judgment/decision.test.ts
- packages/coding-agent/test/judgment/exact-pin.test.ts
- packages/coding-agent/test/launch/service-lifetime.test.ts
- packages/coding-agent/test/main-interactive-input.test.ts
- packages/coding-agent/test/tools.test.ts
- packages/tui/src/overlays/settings-defs.ts
- packages/tui/src/tools/daemon.ts
- packages/utils/src/dirs.ts
- scripts/ci-test-ts.ts
- sdk/go/omp-rpc/wire.go
- sdk/python/omp-rpc/src/omp_rpc/_wire.py
- sdk/rust/omp-rpc/src/wire.rs

## 58929814a4 feat(auth): shared secrets file and MCP shared OAuth namespace
OMP_SHARED_SECRETS_FILE-backed shared secrets, MCP OAuth credentials shared across
profiles with reauth handling.
Must-keep check: test/config/shared-secrets.test.ts, test/mcp-shared-namespace.test.ts.

Files:
- packages/coding-agent/src/config/shared-secrets.ts
- packages/coding-agent/src/mcp/oauth-credentials.ts
- packages/coding-agent/src/mcp/oauth-flow.ts
- packages/coding-agent/src/modes/controllers/mcp-command-controller.ts
- packages/coding-agent/test/config-cli-credentials.test.ts
- packages/coding-agent/test/config/shared-secrets.test.ts
- packages/coding-agent/test/mcp-command-reauth.test.ts
- packages/coding-agent/test/mcp-shared-namespace.test.ts

## eb338273b8 feat(presets): /models Presets sidebar with full-semantics session-scoped presets
Model presets config, Presets sidebar in the /models hub, selector wiring.
Must-keep check: test/model-presets.test.ts, test/model-hub.test.ts,
tui/test/model-picker-native.test.ts, tui/test/model-hub-assign-scope.test.ts.

Files:
- docs/models.md
- docs/settings.md
- packages/coding-agent/src/config/model-presets.ts
- packages/coding-agent/src/config/model-settings.ts
- packages/coding-agent/src/config/settings.ts
- packages/coding-agent/src/modes/controllers/selector-controller.ts
- packages/coding-agent/src/modes/model-browser-source.ts
- packages/coding-agent/src/slash-commands/builtin-modes.ts
- packages/coding-agent/test/model-hub.test.ts
- packages/coding-agent/test/model-presets.test.ts
- packages/tui/src/overlays/model-hub.ts
- packages/tui/test/model-hub-assign-scope.test.ts
- packages/tui/test/model-picker-native.test.ts

## e4a38c70b5 feat(async): wall caps and no-progress notices for eval/bash async jobs
Eval wall-cap, async job no-progress warnings and delivery, python executor timeouts.

Files:
- packages/coding-agent/src/async/job-manager.ts
- packages/coding-agent/src/eval/executor-base.ts
- packages/coding-agent/src/eval/js/executor.ts
- packages/coding-agent/src/eval/preludes.ts
- packages/coding-agent/src/eval/wall-cap.ts
- packages/coding-agent/src/prompts/system/async-no-progress.md
- packages/coding-agent/src/prompts/tools/eval.md
- packages/coding-agent/src/session/async-job-delivery.ts
- packages/coding-agent/src/tools/eval.ts
- packages/coding-agent/test/async-job-no-progress.test.ts
- packages/coding-agent/test/core/python-executor-timeout.test.ts
- packages/coding-agent/test/eval/browser-prelude-facade.test.ts
- packages/coding-agent/test/tools/bash-wall-cap.test.ts
- packages/coding-agent/test/tools/eval-wall-cap.test.ts

## 96b7237709 feat(reduction): semantic bash output pruning
Judgment-backed pruning of bash output with protected spans and contract.
Check: test/reduction/output-pruning.test.ts, test/tools/bash-output-pruning.test.ts.

Files:
- docs/tools/bash.md
- packages/coding-agent/src/prompts/tools/bash-output-prune-needs-all.md
- packages/coding-agent/src/prompts/tools/bash-output-prune-omit-criteria.md
- packages/coding-agent/src/prompts/tools/bash-output-prune-omit.md
- packages/coding-agent/src/prompts/tools/bash.md
- packages/coding-agent/src/reduction/contract.ts
- packages/coding-agent/src/reduction/output-pruning.ts
- packages/coding-agent/src/reduction/protection.ts
- packages/coding-agent/src/tools/bash.ts
- packages/coding-agent/test/reduction/output-pruning.test.ts
- packages/coding-agent/test/tools/bash-output-pruning.test.ts

## ca1d325ba3 feat(context): small-window compaction and semantic shake
Compaction thresholds for small windows, semantic-shake keep decisions, task
context reduction and session maintenance.
Check: test/session/semantic-shake.test.ts, test/compaction*.test.ts.

Files:
- docs/compaction.md
- packages/agent/src/compaction/compaction.ts
- packages/agent/src/compaction/utils.ts
- packages/coding-agent/src/prompts/system/semantic-shake-keep-criteria.md
- packages/coding-agent/src/prompts/system/semantic-shake-keep.md
- packages/coding-agent/src/reduction/semantic-shake.ts
- packages/coding-agent/src/reduction/task-context.ts
- packages/coding-agent/src/session/agent-session-events.ts
- packages/coding-agent/src/session/agent-session.ts
- packages/coding-agent/src/session/compaction-methods.ts
- packages/coding-agent/src/session/session-maintenance.ts
- packages/coding-agent/src/session/shake-types.ts
- packages/coding-agent/src/slash-commands/builtin-lifecycle.ts
- packages/coding-agent/test/compaction-serialization.test.ts
- packages/coding-agent/test/compaction.test.ts
- packages/coding-agent/test/reduction/task-context.test.ts
- packages/coding-agent/test/session/semantic-shake.test.ts
- packages/coding-agent/test/slash-commands/shake.test.ts

## 5ac49c6632 feat(find): semantic and bounded find (jfind)
Judgment-ranked find with bounded mode over named paths, excerpts and TUI rendering.
Check: test/tools/jfind-bounded.test.ts, tui/test/find-render.test.ts.

Files:
- docs/tools/find.md
- packages/coding-agent/src/prompts/tools/find-exists-criteria.md
- packages/coding-agent/src/prompts/tools/find-exists-question.md
- packages/coding-agent/src/prompts/tools/find-select-question.md
- packages/coding-agent/src/prompts/tools/find.md
- packages/coding-agent/src/tools/jfind/bounded.ts
- packages/coding-agent/src/tools/jfind/excerpts.ts
- packages/coding-agent/src/tools/jfind/index.ts
- packages/coding-agent/src/tools/jfind/ranking.ts
- packages/coding-agent/test/fixtures/find-bounded/handbook.txt
- packages/coding-agent/test/fixtures/find-bounded/notes.md
- packages/coding-agent/test/fixtures/find-bounded/spill.ts
- packages/coding-agent/test/tools/jfind-bounded.test.ts
- packages/tui/src/tools/find.ts
- packages/tui/test/find-render.test.ts

## 1bb1bd27a2 feat(skills): recommend_skills tool
Skill relevance ranking (semantic, lexical fallback) exposed as recommend_skills.
Check: test/skill-recommend.test.ts, test/tools/recommend-skills.test.ts.

Files:
- docs/tools/recommend_skills.md
- packages/coding-agent/src/extensibility/skill-recommend.ts
- packages/coding-agent/src/prompts/system/skill-recommend-applicable.md
- packages/coding-agent/src/prompts/system/skill-recommend-fits-criteria.md
- packages/coding-agent/src/prompts/system/skill-recommend-fits.md
- packages/coding-agent/src/prompts/system/skill-recommend-select.md
- packages/coding-agent/src/prompts/tools/recommend-skills.md
- packages/coding-agent/src/tools/recommend-skills.ts
- packages/coding-agent/test/skill-recommend.test.ts
- packages/coding-agent/test/tools/recommend-skills.test.ts

## fa2ea46dc9 feat(task): herdr pane subagents and structured subagent results
Herdr pane backend/CLI/preflight, structured subagent output, subagent tool policy.
Check: test/task/pane-*.test.ts.

Files:
- docs/tools/task.md
- packages/coding-agent/src/prompts/task/pane-subagent.md
- packages/coding-agent/src/task/executor.ts
- packages/coding-agent/src/task/index.ts
- packages/coding-agent/src/task/pane/herdr-backend.ts
- packages/coding-agent/src/task/pane/herdr-cli.ts
- packages/coding-agent/src/task/pane/preflight.ts
- packages/coding-agent/src/task/structured-subagent.ts
- packages/coding-agent/src/task/subagent-tool-policy.ts
- packages/coding-agent/src/task/types.ts
- packages/coding-agent/test/task/pane-backend.test.ts
- packages/coding-agent/test/task/pane-fake-herdr.ts
- packages/coding-agent/test/task/pane-preflight.test.ts
- packages/coding-agent/test/task/pane-structured.test.ts
- packages/tui/src/tools/task.ts

## 52ca6ea268 feat(browser-relay): relay pinning, binding and extension updates
Browser relay extension, daemon/bridge/probe/binding, CLI, pinning.
Check: test/tools/browser-relay-*.test.ts.

Files:
- packages/browser-relay/CHANGELOG.md
- packages/browser-relay/README.md
- packages/browser-relay/extension/background.ts
- packages/browser-relay/extension/chrome.d.ts
- packages/browser-relay/extension/manifest.json
- packages/browser-relay/package.json
- packages/browser-relay/scripts/build-extension.ts
- packages/coding-agent/src/cli/browser-relay-cli.ts
- packages/coding-agent/src/commands/browser-relay.ts
- packages/coding-agent/src/tools/browser/relay-record.lifecycle.test.ts
- packages/coding-agent/src/tools/browser/relay/binding.ts
- packages/coding-agent/src/tools/browser/relay/bridge.ts
- packages/coding-agent/src/tools/browser/relay/daemon.ts
- packages/coding-agent/src/tools/browser/relay/extension-assets/background.js.txt
- packages/coding-agent/src/tools/browser/relay/extension-assets/manifest.json.txt
- packages/coding-agent/src/tools/browser/relay/kind.ts
- packages/coding-agent/src/tools/browser/relay/probe.ts
- packages/coding-agent/src/tools/browser/relay/protocol.ts
- packages/coding-agent/src/tools/browser/relay/server.ts
- packages/coding-agent/test/tools/browser-relay-asset.test.ts
- packages/coding-agent/test/tools/browser-relay-bridge.test.ts
- packages/coding-agent/test/tools/browser-relay-compat.test.ts
- packages/coding-agent/test/tools/browser-relay-pinning.test.ts
- packages/coding-agent/test/tools/browser-relay-probe.test.ts
- packages/coding-agent/test/tools/browser-relay-server.test.ts
- packages/coding-agent/test/tools/relay-binding-fixture.ts
- packages/coding-agent/test/tools/relay-extension-harness.ts

## 6b696a2836 feat(browser): tab supervisor, browser tasks and automation permissions
Owned-tab supervisor/worker, orphan registry, browser task loop (observe/act/verify),
automation policy with project grants (incl. targets:["*"] any-origin grants).
Check: test/tools/browser-*.test.ts, automation-policy.permission.test.ts.

Files:
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000000.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000001.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000002.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000003.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000004.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000005.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000006.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000007.jpg
- packages/coding-agent/omp-browser-recording-HuImrB/frame-000000008.jpg
- packages/coding-agent/src/prompts/tools/browser-task-operation.md
- packages/coding-agent/src/prompts/tools/browser-task-target.md
- packages/coding-agent/src/prompts/tools/browser-task-text.md
- packages/coding-agent/src/prompts/tools/browser-task-verify-criteria.md
- packages/coding-agent/src/prompts/tools/browser-task-verify.md
- packages/coding-agent/src/prompts/tools/browser.md
- packages/coding-agent/src/tools/automation-policy.ts
- packages/coding-agent/src/tools/browser.ts
- packages/coding-agent/src/tools/browser/binding.lifecycle.test.ts
- packages/coding-agent/src/tools/browser/declarations.d.ts
- packages/coding-agent/src/tools/browser/launch.ts
- packages/coding-agent/src/tools/browser/orphan-registry.ts
- packages/coding-agent/src/tools/browser/orphan.lifecycle.test.ts
- packages/coding-agent/src/tools/browser/prelude-definition.ts
- packages/coding-agent/src/tools/browser/prelude.js
- packages/coding-agent/src/tools/browser/prelude.py
- packages/coding-agent/src/tools/browser/profile.lifecycle.test.ts
- packages/coding-agent/src/tools/browser/reaper-runtime.lifecycle.test.ts
- packages/coding-agent/src/tools/browser/registry.ts
- packages/coding-agent/src/tools/browser/shared-daemon.ts
- packages/coding-agent/src/tools/browser/tab-protocol.ts
- packages/coding-agent/src/tools/browser/tab-supervisor.ts
- packages/coding-agent/src/tools/browser/tab-worker.ts
- packages/coding-agent/src/tools/browser/task/candidates.ts
- packages/coding-agent/src/tools/browser/task/driver.ts
- packages/coding-agent/src/tools/browser/task/loop.ts
- packages/coding-agent/src/tools/browser/task/observe.js
- packages/coding-agent/src/tools/browser/task/run.ts
- packages/coding-agent/src/tools/browser/task/runtime.js
- packages/coding-agent/src/tools/browser/task/text-value.ts
- packages/coding-agent/src/tools/browser/task/types.ts
- packages/coding-agent/test/fixtures/automation-lease-holder.ts
- packages/coding-agent/test/fixtures/browser-task/app.js
- packages/coding-agent/test/fixtures/browser-task/done.html
- packages/coding-agent/test/fixtures/browser-task/fixture.html
- packages/coding-agent/test/tools/automation-policy.permission.test.ts
- packages/coding-agent/test/tools/automation-project-grants.test.ts
- packages/coding-agent/test/tools/browser-a11y.test.ts
- packages/coding-agent/test/tools/browser-attach.test.ts
- packages/coding-agent/test/tools/browser-cmux-release-mid-run.test.ts
- packages/coding-agent/test/tools/browser-console.test.ts
- packages/coding-agent/test/tools/browser-emulation.test.ts
- packages/coding-agent/test/tools/browser-freeze-settle.test.ts
- packages/coding-agent/test/tools/browser-identity.test.ts
- packages/coding-agent/test/tools/browser-interactions.test.ts
- packages/coding-agent/test/tools/browser-nav-frames-dialogs.test.ts
- packages/coding-agent/test/tools/browser-network.test.ts
- packages/coding-agent/test/tools/browser-open-download.test.ts
- packages/coding-agent/test/tools/browser-open-options.test.ts
- packages/coding-agent/test/tools/browser-orphan-registry.test.ts
- packages/coding-agent/test/tools/browser-owned-tab.test.ts
- packages/coding-agent/test/tools/browser-queries.test.ts
- packages/coding-agent/test/tools/browser-react-vitals.test.ts
- packages/coding-agent/test/tools/browser-recording.test.ts
- packages/coding-agent/test/tools/browser-schema.test.ts
- packages/coding-agent/test/tools/browser-scope.ts
- packages/coding-agent/test/tools/browser-screenshot-plus.test.ts
- packages/coding-agent/test/tools/browser-shared-wedge.test.ts
- packages/coding-agent/test/tools/browser-snapshot-plus.test.ts
- packages/coding-agent/test/tools/browser-storage-state.test.ts
- packages/coding-agent/test/tools/browser-tab-press-guard.test.ts
- packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts
- packages/coding-agent/test/tools/browser-task-decisions.test.ts
- packages/coding-agent/test/tools/browser-task-facade.test.ts
- packages/coding-agent/test/tools/browser-task-fixture.test.ts
- packages/coding-agent/test/tools/browser-webmcp.test.ts
- packages/coding-agent/test/tools/prelude-automation.permission.test.ts

## b08005916e feat(computer): desktop control via cua-driver with task loop
Computer tool CUA backend/driver, permissions and task loop.
Check: test/tools/computer*.test.ts, cua-*.test.ts.

Files:
- docs/tools/computer.md
- packages/coding-agent/src/prompts/tools/computer-cua-driver.md
- packages/coding-agent/src/prompts/tools/computer-cua-permissions.md
- packages/coding-agent/src/prompts/tools/computer-permissions.md
- packages/coding-agent/src/prompts/tools/computer-task-select.md
- packages/coding-agent/src/prompts/tools/computer-task-value.md
- packages/coding-agent/src/prompts/tools/computer-task-verify.md
- packages/coding-agent/src/prompts/tools/computer.md
- packages/coding-agent/src/tools/computer.ts
- packages/coding-agent/src/tools/computer/call.ts
- packages/coding-agent/src/tools/computer/cua-backend.ts
- packages/coding-agent/src/tools/computer/cua-driver.ts
- packages/coding-agent/src/tools/computer/declarations.d.ts
- packages/coding-agent/src/tools/computer/prelude.js
- packages/coding-agent/src/tools/computer/prelude.py
- packages/coding-agent/src/tools/computer/task/candidates.ts
- packages/coding-agent/src/tools/computer/task/loop.ts
- packages/coding-agent/src/tools/computer/task/observation.ts
- packages/coding-agent/src/tools/computer/task/surface.ts
- packages/coding-agent/src/tools/computer/task/text-value.ts
- packages/coding-agent/src/tools/computer/task/types.ts
- packages/coding-agent/src/tools/computer/worker.ts
- packages/coding-agent/test/tools/computer-task.test.ts
- packages/coding-agent/test/tools/computer-user-only-settings.test.ts
- packages/coding-agent/test/tools/computer.permission.test.ts
- packages/coding-agent/test/tools/computer.test.ts
- packages/coding-agent/test/tools/cua-backend.test.ts
- packages/coding-agent/test/tools/cua-driver.test.ts
