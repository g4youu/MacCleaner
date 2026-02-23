# Changelog

All notable changes to this project are documented in this file.

## [1.2.0] - 2026-02-23

- Added CPU Monitor page with top CPU processes and Activity Monitor shortcut.
- Added macOS menu bar (tray) integration with quick RAM actions and status.
- Added adaptive refresh engine and user-selectable refresh profiles:
  - Real-time
  - Balanced
  - Power Saver
- Added safer RAM tooling:
  - Deep RAM Clean (safe mode with guarded app termination)
  - Improved RAM cleanup reporting with immediate vs stabilized results
  - Session-based admin caching flow to reduce repeated password prompts
- Improved window behavior and UX:
  - Fixed tray "Show MacCleaner" crash after sleep/wake
  - Added dedicated top drag strip and updated header styling
  - Moved refresh action to a less distracting location
- Updated packaging and release metadata to `v1.2.0`.

## [1.0.0] - 2026-02-23

- Initial public release of MacCleaner.
- Added System Overview, RAM Cleaner, Disk Cleaner, Uninstaller, Startup Items, and Privacy Cleaner.
- Fixed renderer crash caused by duplicate `api` declaration.
- Added packaging icon asset and generated macOS DMG outputs for arm64 and x64.
- Improved production behavior by limiting DevTools auto-open to development mode.
- Added loader error handling for disk/apps/startup views.
