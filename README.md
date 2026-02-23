# MacCleaner

MacCleaner is a macOS utility app built with Electron to inspect and clean common system junk safely from one interface.

## Features

- System Overview: Live RAM, CPU, disk, and battery stats.
- RAM Cleaner: Memory breakdown + `purge` support.
- Disk Cleaner: Scan and clean cache/log/trash style categories.
- Uninstaller: Remove apps and common leftover files.
- Startup Items: Inspect launch agents/daemons and toggle enabled state.
- Privacy Cleaner: Clear selected local history/traces.

## Requirements

- macOS 11+
- Node.js 18+
- npm 9+

## Local Development

```bash
npm install
npm start
```

## Build Installers (.dmg)

```bash
npm run dist
```

Artifacts are generated in `dist/`:

- `MacCleaner-<version>-arm64.dmg`
- `MacCleaner-<version>.dmg` (x64)

## Install from DMG

1. Open the DMG file.
2. Drag `MacCleaner` into `Applications`.
3. First launch may require allowing the app in `System Settings -> Privacy & Security`.

## GitHub Release Flow

```bash
git tag v1.0.0
git push origin v1.0.0
```

Then on GitHub:

1. Open `Releases` -> `Draft a new release`.
2. Select tag `v1.0.0`.
3. Upload both DMGs from `dist/`.
4. Publish.

## Security and Permissions

Some actions use native macOS commands and may prompt for admin credentials (for example RAM purge and some startup-item operations).

## Project Structure

```text
mac-cleaner-app/
├── main.js
├── preload.js
├── renderer/
│   └── index.html
├── assets/
│   └── icon.icns
├── entitlements.mac.plist
└── package.json
```

## Troubleshooting

- App blocked by macOS: Allow in `Privacy & Security` and relaunch.
- Browser history cleanup fails: Close Safari/Chrome first.
- Build warning about signing: Expected for unsigned local builds; configure Developer ID for public distribution.

## License

MIT. See `LICENSE`.
