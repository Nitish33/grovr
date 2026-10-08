# Agent handover: DevTool (Grovr) — branch `feat/worktree-quick-actions`

Written for an AI coding agent (Codex) taking over this repo. Read this, then `CLAUDE.md` and `.claude/rules/*.md`
(they are written for another tool, so they may not load automatically; their rules still apply — see "Conventions").

## 1. State at handover

- Branch `feat/worktree-quick-actions`, **clean and pushed** (`008cdcd` is HEAD). Base branch: `main`. No PR opened yet.
- App: Tauri v2 (Rust) + React 19/TypeScript desktop app, product name **DevTool** (repo/identifier still `grovr`).
  A worktree manager that grew a "dev tools" side: JSON viewer, notes, quick links, simulator/emulator tabs.
- The user runs `pnpm tauri dev` themself and tests in it; it hot-reloads. Don't start a second dev instance
  (port 1420 is taken).
- Verification available to you: `npx tsc --noEmit` and `cargo check --manifest-path src-tauri/Cargo.toml`.
  **`cargo test` does not compile** (existing tests call async functions without `.await`) — pre-existing, not ours.
  There is no GUI automation, so most visual behaviour below was verified only by reasoning plus terminal probes.

## 2. Conventions (from CLAUDE.md / .claude/rules — summarised)

- Frontend calls Rust only through `src/lib/api.ts` (`invoke`). Rust commands return `Result<T, String>`, never panic, no
  `anyhow`. Keep TS types in `src/lib/api.ts` in sync with `src-tauri/src/types.rs` / command return structs (snake_case).
- Never send tokens to the frontend. Use `git2` or `std::process::Command` for git.
- TailwindCSS only (`@apply` in `src/index.css` is the house style), semantic theme colours, no pure black, no `any`,
  no `@ts-ignore`. Known, deliberate exceptions to "no inline styles": grid templates computed at runtime (JSON viewer
  split, log columns).
- Add a new Rust command in 3 places: the `#[tauri::command]` fn, `use` + `invoke_handler![...]` in `src-tauri/src/lib.rs`,
  and a wrapper in `src/lib/api.ts`. New windows must be listed in `src-tauri/capabilities/default.json` (`windows`; globs work).
- Commit style: `feat(scope): summary` + body; the user asks explicitly before commits/pushes ("commit and push").
  Existing commits end with a `Co-Authored-By:` trailer for the agent that wrote them.
- macOS-only code is gated with `#[cfg(target_os = "macos")]` (the Rust `follow` module in `dock.rs`).

## 3. What was built (newest first) and where it lives

### 3.1 Quick bar (a.k.a. "dock") — `008cdcd`, `cbc67f6`
A small bar docked to the right of a running simulator/emulator window. Opened from the **Quick bar** button on a running
device row (`DevicesTab.tsx`); the same button closes it.

- **Rust:** `src-tauri/src/commands/dock.rs`. A follow loop (`follow::run_follow_loop`, polls every 40 ms) reads window
  geometry with CoreGraphics (`core-graphics`/`core-foundation` crates, macOS-only), finds the device window, and places the
  bar with native AppKit coordinates (`place`). Window positions need no permission; window **titles** need Screen Recording
  permission, so matching falls back to "largest window of the right process".
- **Frontend:** `src/pages/DockWindow.tsx` (route `?view=dock`, see `src/main.tsx`). Buttons: stream logs, screenshot,
  dark mode, open clipboard link, record, shut down, and a gear (settings) at the bottom.
- **Actions** (`device_quick_action`): `screenshot` (simctl io / `adb exec-out screencap`, then copied to the clipboard as an
  image via `osascript` — in-process NSPasteboard writes from worker threads crash, see `clipboard.rs`), `toggle_appearance`,
  `open_url` (URL validated; Android URL shell-quoted), `shutdown`.
- **Toasts:** `show_device_toast` opens a transient click-through window (`?view=toast`, `ToastWindow.tsx`) centred on the
  device window. Kinds `ok|error|busy` (busy = spinner), optional `sticky`. A new toast replaces the previous.
- **Z-order:** the bar is NOT always-on-top. The loop keeps it just above the device window with
  `-[NSWindow orderWindow:relativeTo:]` (`order_above`), re-applied when the device is raised, so windows opened from the bar
  (logs, settings) sit above it. Toast/recording-pill windows are still always-on-top (short-lived / click-through).
- Debug: run with `GROVR_DOCK_DEBUG=1` to print what the loop is doing.

### 3.2 Screen recording — `008cdcd`
- **Rust:** `src-tauri/src/commands/recording.rs`. iOS: `xcrun simctl io <udid> recordVideo --codec=h264 --force <file>`;
  stopped with **SIGINT** (kill would corrupt the file). Android: `adb shell screenrecord --time-limit 180 /sdcard/…` on the
  device, stopped with `kill -2 $(pidof screenrecord)`, then `adb pull` + `rm`. Files go to `<tmp>/grovr-recordings/`.
- Start returns after a ≤350 ms early-death check. The record button shows spinner → red pulsing stop → spinner.
  While recording, a **REC mm:ss pill** (`RecordingIndicatorWindow.tsx`, `?view=recording`) is shown at the top of the device.
- On stop: iOS video is shrunk with **ffmpeg** if present (`shrink_video`: x264, CRF/fps/max-width/codec from settings; a
  47 s, 45 MB recording became 0.7 MB). Then the **file path** (not the file) is copied to the clipboard and a toast shows
  the size change. If ffmpeg is missing the original is kept silently (the settings window shows a notice).
- Cleanup: old recordings deleted when a new one starts (`recording_keep_hours`, default 24, 0 = never). `stop_orphans()`
  (startup) SIGINTs `simctl … recordVideo …/grovr-recordings/` processes left by a previous run; `stop_all()` runs on exit.
  This matters: a killed/hot-reloaded dev app loses its child handles and the recorder otherwise keeps writing ~1 MB/s.

### 3.3 Quick bar settings window — `008cdcd`
Gear icon → `open_quick_bar_settings` (`windows.rs`) → `QuickBarSettingsWindow.tsx` (`?view=quickbar-settings`), two panes:
**Screenshot** (also save to Desktop) and **Recording** (shrink on/off, CRF slider, fps, max width, H.264/HEVC, keep-for,
ffmpeg status, and the **saved recordings list**: play / copy path / reveal / delete / delete all). The window opens beside
the bar (`place_beside`, clamped to the visible screen area). Settings are `QuickBarSettings` in `types.rs`
(persisted in `settings.json` like other settings; `set_quick_bar_settings` clamps values). Recording-file commands only
operate on files inside the recordings folder (canonicalised check).

### 3.4 Native device logs window — `3ac736d`
"Stream logs" on running devices → `open_log_window` (`logs.rs`, `?view=logs`, `LogsWindow.tsx`).
- iOS `xcrun simctl spawn <udid> log stream --style compact --level debug`; Android `adb logcat -v threadtime -T 500`.
  A reader thread batches lines (50 ms / 500 lines) and emits `device-log` events to that window; `device-log-end` if the
  process dies. The child is killed when the window is destroyed or restarted.
- `src/lib/logs.ts`: merges multi-line messages into one entry (Android: same header + unclosed bracket or stack trace),
  pretty-prints JSON/JS object literals (JSON5), parses levels. `useLogStream.ts` holds the 5000-entry buffer; when full it
  drops entries the current filters hide first. Filters: level, text, and an app filter (`package:` Android via PID→package
  lookup `list_android_processes`; `app:` iOS). On iOS the app filter also becomes a `--predicate` on the stream.
- Columns menu (`components/log-viewer/LogColumnsMenu.tsx`, `useLogColumns.ts`), pause, copy, **Copy for AI**
  (`save_log_snapshot` writes `<tmp>/grovr-logs/*.log` and copies "Check this file for logs '<path>'").
- Suggestions for the app filter come from `list_user_apps` (third-party apps only).

### 3.5 Worktree git status chips — `faff4f9`
`get_worktree_git_status` (`git.rs`, `git status --porcelain=v2 --branch --no-optional-locks`) → `WorktreeGitStatus.tsx`.
Shown on each worktree row when not hovered (↓pull, ↑push, +staged, ~changed, conflicts, "local" = no upstream, "clean");
hover swaps in the quick-action buttons. **Loaded once per `loadData()` (initial load + Refresh button). The user explicitly
asked for no polling.**

### 3.6 Smaller items
- Worktree row shows its folder path under the branch name (`worktree-path`); the branch column has `min-w-0` so long
  paths truncate instead of pushing the actions column off-screen.
- JSON viewer: save with a title, History dialog, Cmd/Ctrl+S, update-in-place + toast (`useSavedJson.ts`,
  `components/json/JsonSaveDialogs.tsx`; stored in localStorage `grovr.jsonViewer.saved`).
- `useAppTheme.ts` extracted: secondary windows follow the app theme.

## 4. Gotchas that cost time (don't relearn them)

1. **`.gitignore` has a bare `logs` entry.** Any directory named `logs` is silently ignored (that's why the columns menu lives
   in `components/log-viewer/`). Check `git status` shows new files before committing.
2. **`tauri-plugin-window-state` restores saved position/visibility for every window label.** It fought the bar (stale
   position, window popping up). The filter in `lib.rs` excludes `dock-*` and `quickbar-settings`. Any new window you
   position yourself must be excluded too.
3. **Device id vs display name.** Android: id = AVD name (`Pixel_6a`, used in `adb`, `-avd`, window title
   "Android Emulator - Pixel_6a:5554"); display name = "Pixel 6a". iOS: id = UDID, window title = display name.
   Use the right one (see `match_name` in `dock.rs::open`). AVD matching must be exact (`Pixel_6a` ≠ `Pixel_6a_API_34`).
4. **NSPasteboard is not thread-safe** — don't write the clipboard from worker threads in Rust (use the clipboard plugin on the
   frontend, `read_clipboard_text` on the main thread, or `osascript` as `copy_png_to_clipboard` does).
5. **`adb shell` joins arguments into one device shell command line** — quote anything user-provided (see `open_url`).
6. **Child processes:** stop `simctl` with SIGINT; kill the Android recorder on the device, not just the adb client.
   `start_log_stream` replaces and kills any previous stream for the window label (an earlier overlap leaked `adb logcat`s).
7. **Tauri `visible(false)` + plugins:** build windows hidden, position them natively, then show (avoids flashes).
8. Android `screenrecord` stops itself after 180 s; the button doesn't notice until you click stop.

## 5. Unverified / please test (needs a human with the GUI)

- Bar following while the device window is dragged (expected lag ≤ a frame or two); two simulators open at once (without
  Screen Recording permission it picks the largest window).
- After the z-order change: clicking the simulator may flicker the bar for ≤ 40 ms; confirm logs/settings windows open above the
  bar; confirm another app covering the simulator also covers the bar.
- Clicking the bar activates this app and might raise the main window (a non-activating NSPanel, e.g. `tauri-nspanel`, is the
  fix if so).
- Settings window opening beside the bar on a second monitor / near the right screen edge (clamped, so it overlaps the bar).
- Full record → stop → shrink → clipboard-path flow through the UI with HEVC selected; shrinking when ffmpeg is absent.

## 6. Suggested next steps (not started)

- **ffmpeg missing UX:** one-time hint in the toast; look in `/opt/local/bin` (MacPorts); `grovr.cask.rb` could
  `depends_on formula: "ffmpeg"`. Do not bundle ffmpeg (x264 is GPL).
- Cap iOS recording length (e.g. auto-stop at 10 min); optionally shrink Android recordings too.
- Run the 24 h recording cleanup at app start, not only when a recording starts.
- **Network logger** (discussed, no code): embedded MITM proxy (e.g. `hudsucker`), iOS via `networksetup` + `simctl keychain
  add-root-cert`, Android via `adb shell settings put global http_proxy 10.0.2.2:<port>` + a system CA (needs a rootable
  "Google APIs" image; Play images can't be rooted), metadata-only fallback for pinned apps, window modelled on the logs window.
- Android: same source-side filtering as iOS (`logcat --pid`) so a chatty device can't push matches out of the buffer.
- Fix the broken `cargo test` build and add tests for `lib/logs.ts` (entry merging, level parsing, JSON formatting) — pure
  functions, easy to test.
- Open a PR for `feat/worktree-quick-actions` (21 commits ahead of `main`, including the earlier Simulator/Emulator tabs, Notes, Quick links and JSON viewer work; the
  scope is much broader than the branch name, so consider splitting or renaming).

## 7. Handy facts

- Temp folders: `<tmp>/grovr-logs` (Copy for AI snapshots), `<tmp>/grovr-recordings` (videos), `<tmp>/grovr-screenshots`
  (transient). `<tmp>` is the per-user macOS temp dir (`/var/folders/…/T`), which macOS also clears on its own.
- Window routes live in `src/main.tsx`: `?view=json|logs|dock|toast|recording|quickbar-settings`; everything else is `<App />`.
- Event names: `device-log`, `device-log-end` (logs window only).
- Stray processes to know about when debugging: `adb … logcat`, `simctl … recordVideo`, `adb … screenrecord`.
- Scratch probes used during development (Swift/Rust programs listing CoreGraphics windows) lived in a temp scratchpad and are
  not in the repo; `CGWindowListCopyWindowInfo` with `.optionAll` lists windows on other Spaces too.
