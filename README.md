<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Grovr Logo">
</p>

<h1 align="center">Grovr</h1>

<p align="center">
  A native Git worktree manager for macOS
</p>

<p align="center">
  <a href="https://github.com/j1king/grovr/releases"><img src="https://img.shields.io/github/v/release/j1king/grovr" alt="Release"></a>
  <a href="https://github.com/j1king/grovr/releases"><img src="https://img.shields.io/github/downloads/j1king/grovr/total" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white" alt="Tauri v2">
</p>

---

Git worktrees let you work on multiple branches simultaneously without stashing or context switching. Grovr makes managing them effortless with a native macOS interface.

<p align="center">
  <img src="docs/main.webp" alt="Grovr Screenshot" width="800">
</p>

---

## Features

### One-Click IDE Launch

Click any worktree to open it in your preferred editor. Supports VS Code, Cursor, Zed, JetBrains IDEs, and custom commands.

<p align="center">
  <img src="docs/feature-ide.webp" alt="IDE Launch" width="800">
</p>

### Search & Keyboard Navigation

Type to search, use arrow keys to navigate, press Enter to launch. No mouse required.

<p align="center">
  <img src="docs/feature-search.webp" alt="Search & Navigation" width="800">
</p>

### Smart Worktree Creation

Create worktrees from clipboard with automatic branch name extraction. Paste a Jira issue key, GitHub PR URL, or any text matching your custom regex pattern. Also supports `grovr://` deep links for automation.

<p align="center">
  <img src="docs/feature-create.gif" alt="Create from URL" width="800">
</p>

### PR & Jira Status at a Glance

See pull request status (draft, review requested, approved, CI status) and Jira issue state directly in the worktree list. No more tab switching.

### Quick Cleanup

Delete worktrees with one click. Optionally delete the local branch too—no more orphaned branches cluttering your repo.

### Spotlight Quick Links

Type `dev:<link name>` in Spotlight and press Enter to open a saved quick link in your browser. Links are added, renamed and removed from Spotlight as you edit them, and macOS clears them when the app is uninstalled.

---

## Installation

**Homebrew (Recommended)**

```bash
brew install --cask j1king/tap/grovr
```

**Manual Download**

Download the latest `.dmg` from [Releases](https://github.com/j1king/grovr/releases).

**Requirements:** macOS 10.15+ and Git installed.

---

## Development

```bash
# Clone and install
git clone https://github.com/j1king/grovr.git
cd grovr
pnpm install

# Run dev server
pnpm tauri dev

# Build for production
pnpm tauri build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guide.

## Troubleshooting

### Spotlight doesn't show `dev:<link name>`

- **Run a built app, not `pnpm tauri dev`.** Spotlight indexes items per app bundle, so the dev binary never appears. Build with `pnpm tauri build` and launch the `.app`.
- **Use a stable signature.** Ad-hoc signed builds (the default for local debug builds) get a new identity on every rebuild, and Spotlight may ignore them. Sign with an Apple Development or Developer ID certificate, and run the app from `/Applications` or `~/Applications`:
  ```bash
  codesign --force --deep --options runtime -s "<identity>" \
    --entitlements src-tauri/entitlements.plist /path/to/DevTool.app
  ```
  List identities with `security find-identity -v -p codesigning`.
- **Check Spotlight settings.** In System Settings → Spotlight → Search Results, make sure `DevTool` is enabled. Several `DevTool-<hash>` entries are leftovers from earlier ad-hoc builds and can be ignored.
- **Wait a little.** New items can take 10-30 seconds to appear. Try `dev name` if `dev:name` doesn't match.
- **Confirm indexing.** Launch the app from a terminal and look for `[spotlight] indexed N quick links`. A `[spotlight] indexing failed` line includes the system error.

### Spotlight result shows but Enter doesn't open the link

- Launch the app from a terminal and click the result. A `[spotlight] continue activity` line means the click arrived. If it doesn't appear, check for `[spotlight] delegate hook installed`.
- Links with `file:`, `javascript:`, `data:`, `vbscript:` or `blob:` schemes are blocked on purpose.

### Spotlight results remain after removing a link

Reindexing runs whenever quick links are saved. If a stale result remains, reopen the app, or save any quick link change to force a refresh.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Rust, Tauri v2, git2, tokio |
| Frontend | React 19, TypeScript, Vite |
| Styling | TailwindCSS, Radix UI |
| Testing | Playwright |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Tauri](https://tauri.app/), [git2](https://github.com/rust-lang/git2-rs), and [Radix UI](https://www.radix-ui.com/).
