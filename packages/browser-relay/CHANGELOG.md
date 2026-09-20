# Changelog

## [Unreleased]

### Added

- 0.2.0: per-tab markers (`chrome.storage.session`) identify OMP-created tabs and ONE OMP group per window; concurrent group requests merge, groups survive relay disconnects and reconnects, a user dragging a marked tab out is a persistent opt-out (`chrome.storage.local`), pinned tabs are never grouped, and only adopted tabs are ungrouped. `hello` reports the per-run `generation`, the manifest `extensionVersion`, and a durable per-install `installId` (`chrome.storage.local`); a relay closing with 4401/4403 (profile unbound/mismatch) shows a `!` badge and backs off 60 s. The generation and install id are written and read back before any `hello`; a `chrome.storage` write that fails or does not read back means no dial at all — the same `!` badge and 60 s backoff, then a retry — so an id that would not survive a worker restart is never announced. `extension/background.ts` is the single source again: `bun scripts/build-extension.ts` regenerates the CLI-embedded assets.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
