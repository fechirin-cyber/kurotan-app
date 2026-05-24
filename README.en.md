# kurotan

[日本語](README.md) | **English**

> **Unofficial / Fan-made** — This app is NOT an official Anthropic / Claude Code product.
> Anthropic and Claude are trademarks of Anthropic PBC. This app is not affiliated with Anthropic in any way.
> The visual is inspired as fan-art by the pixel mascot from the Claude Code startup screen.

> **Non-commercial / Free distribution / Personal use only** (see [EULA.md](EULA.md) for details). Support is welcome via ⭐ Star and mentions.
> **Forks are welcome.** If you fork, please credit the original repo.

**"Make AI fun."**

---

## Build / Version Info

- **Current version**: `0.9.74` (verified build, unsigned NSIS installer)
- **Supported OS**: Windows 10 / 11 (x64)
- **Distributable**: `dist/kurotan Setup 0.9.74.exe` (~78 MB)
- **License**: [LICENSE](LICENSE) (MIT) / [EULA.md](EULA.md) (terms) / [NOTICE.md](NOTICE.md) (trademarks / third-party notices)

### Install paths

| Type | Path |
|---|---|
| Application | `%LOCALAPPDATA%\Programs\kurotan\` (~190 MB) |
| User data | `%APPDATA%\kurotan\` (config.json / runtime.json / history) |
| Start menu | `kurotan` |
| Uninstall | Control Panel -> Apps -> kurotan -> Uninstall |

### Install steps (EXE installer, recommended)

For general users. No source build needed — just download and run.

1. Download `kurotan Setup 0.9.74.exe` from the [latest release page](https://github.com/fechirin-cyber/kurotan-app/releases/latest)
2. Double-click the downloaded EXE
3. **SmartScreen dialog** appears (unsigned binary). Click "More info" -> "Run anyway" (see [SmartScreen notice](#smartscreen) below)
4. Accept EULA -> confirm install location -> "Install"
5. Check "Launch kurotan" to auto-start after install
6. On first launch, kurotan-notify hook is automatically registered to `~/.claude/settings.json` (skipped on subsequent launches)

---

## Overview

**kurotan** is a desktop-resident mascot app that visualizes Claude Code session activity in real time.
Whether Claude is thinking, reading a file, running Bash, or stuck on an error — the small mascot in the bottom-right corner of your desktop shows it through expressions, motions, and speech bubbles.

When you run multiple Claude Code sessions in parallel, one kurotan appears per session, lined up side by side. You can see at a glance which session is doing what — a living status indicator that lives quietly in the corner of your desk.

---

## Features

- **Mascot state visualization** — Shows what Claude Code is currently doing (idle / thinking / running a tool / done / error / ended, etc.) through the mascot's expressions and motions
- **Per-tool motions** — Poses change based on the tool being used (`Read` / `Edit` / `Bash` / `WebFetch` / `Skill` etc.)
- **Child kurotan display** — When Claude Code runs auxiliary tasks in parallel, small child mascots line up next to the parent and work together
- **Multi-session parallel display** — When you run multiple Claude Code sessions, one kurotan per session lines up
- **Transparent desktop overlay** — Areas outside the mascot don't block apps behind it
- **Position persistence** — Drag kurotan anywhere; the position is restored on next launch
- **Settings window** — Art style, position reset, language switch, etc., available from the tray
- **Hooks auto-integration** — On first launch, kurotan automatically merges its hooks into Claude Code's settings (`~/.claude/settings.json`). Reinstall / uninstall via Settings
- **Easy Button (かんたんぼたん)** — Floating bar for one-click text send (details [below](#easy-button-usage))

---

## After launch

When you start kurotan, the **mascot appears at the bottom-right of your screen**, and a kurotan icon resides in the **system tray** (the small icon group to the left of the clock).

There's no title bar or close button — the mascot lives directly on the desktop.

### Tray icon right-click menu

| Item | Action |
|---|---|
| **Active sessions: N** | Number of kurotans currently visible (info only) |
| **Settings** | Open the settings window (behavior / appearance / colors) |
| **Close all mascots** | Hide all kurotans (they come back when Claude Code runs again) |
| **Align all** | Realign all kurotans neatly to the bottom-right |
| **Permission mode: Auto / Custom** | Switch how Claude Code asks for tool permissions |
| **Custom permission settings...** | Per-tool ask / allow / deny rules in Custom mode |
| **About** | Version info and unofficial notice |
| **Quit** | Exit kurotan completely (removes tray icon) |

### Mascot right-click menu

| Item | Action |
|---|---|
| **Show session info** | Show the working directory and model name for that kurotan in a bubble |
| **Hide this session** | Hide just this kurotan (others stay) |
| **Align all** | Realign all kurotans to the bottom-right |
| **Close all mascots** | Hide all kurotans |
| **Quit** | Exit kurotan |

### Moving kurotan

- **Drag to move**: Left-click and drag a kurotan to place it anywhere. Position is remembered across restarts.

<a id="smartscreen"></a>
### SmartScreen notice

When you run the installer you'll see a blue **"Windows protected your PC"** dialog. This is because the binary is unsigned, not because it's malicious.

Proceed as follows:

1. Click **"More info"** at the bottom-left of the dialog
2. Click the **"Run anyway"** button that appears
3. Installation starts

### Detection of existing Claude Code sessions

If you launch kurotan **after** Claude Code is already running, only sessions that **had activity within the last 30 minutes** will be detected and shown. Idle sessions older than that won't be picked up.

---

## Easy Button usage

Open from Tray -> "Show Kantan Button" or right-click kurotan -> "Show Kantan Button".

### Basic controls

| Action | Result |
|---|---|
| `+` button | Add a new button |
| Right-click a button | Edit label / send text |
| Drag edges | Resize the bar (buttons auto-arrange by shape) |
| `×` button | Close the bar |
| Japanese input | Sent via clipboard (IME-finalize aware) |

### Send target

When a button is pressed, the key input + Enter is sent to **whatever window is in the foreground at that moment**. Not limited to VSCode — works with any window (Windows Terminal / cmd / PowerShell / Notepad etc.). Intended for **terminals running the Claude Code CLI**.

### 🎯 Focus target (target capture)

Use this when you don't want to re-focus the target window every time:

1. Press the **🎯 button** on the bar
2. A **3-second countdown** begins. During the countdown, position your cursor on the input area of the target window (e.g. VSCode integrated terminal)
3. The cursor position at the end of the countdown is **stored as the send target**
4. From that point on, button presses will automatically move the cursor to the stored position, click to focus the target window, then send

| Action | Result |
|---|---|
| Left-click 🎯 | Start the 3-second countdown to capture cursor position |
| Right-click 🎯 | Clear the stored target (revert to sending to whatever is foreground) |

> **Note**: While a target is stored, even if you bring another app to the foreground, sends will click back to the captured position. If unwanted clicks would be a problem, clear the target via 🎯 right-click.

---

## Run from source (developers)

If you'd rather skip the EXE installer and run from source. Node.js 18+ required.

### 1. Clone the repo and install dependencies

```bash
git clone https://github.com/fechirin-cyber/kurotan-app.git
cd kurotan-app
npm install
```

### 2. Launch kurotan

```bash
npm run dev
```

A tray icon appears and the first kurotan quietly shows up on your desktop.

### 3. Install Claude Code integration hooks

```bash
node src/installer/install-hooks.js
```

This safely merges kurotan hooks (`SessionStart` / `PreToolUse` / `Stop` etc., 10 events total) into `~/.claude/settings.json`.
To preview the changes beforehand use `npm run install-hooks:dry`. To remove them later use `npm run uninstall-hooks`.

### 4. Launch Claude Code in another terminal

```bash
claude
```

A kurotan appears automatically when the session starts and reacts to Claude's activity. Open multiple terminals to spawn multiple kurotans, one per session.

### 5. (Optional) Build the installer EXE yourself

```bash
npm run build
```

Produces `dist/kurotan Setup <version>.exe`.

---

## Requirements

### System requirements

| Item | Required / recommended | Notes |
|---|---|---|
| OS | Windows 10 (1903+) / 11 (x64) | macOS / Linux not supported at this time |
| CPU | Any x64 processor (4 cores recommended) | Very light idle load (1 mascot idle: CPU < 0.5%) |
| RAM | 4 GB or more (500 MB free recommended) | ~350 MB used with 5 mascots in parallel |
| Disk free space | 250 MB or more | Body ~190 MB + user data ~10 MB + headroom |
| Display | 1280×720 or larger | Multi-display: primary monitor only |
| .NET / VC++ runtime | Not required | Bundled with Electron |
| Admin rights | Not required | Installs into user profile (`%LOCALAPPDATA%`) |

### Software dependencies

| Software | Version | Notes |
|---|---|---|
| Claude Code | Official CLI 1.x or later | Integration target. kurotan runs alone but is meant to be used with Claude Code |
| Node.js | 20.x or later | **Only required when running from source** (not needed for the installer build) |
| Electron | 33.x | Bundled with the installer |

### Supported Claude Code variants

| Variant | Supported | Notes |
|---|---|---|
| Claude Code **CLI** (run `claude` in a terminal) | ✅ | Standard usage |
| Claude Code **Desktop app** | ✅ | Triggered via local `~/.claude/settings.json` hooks |
| **Web version (claude.ai)** | ❌ | No local hook mechanism — not supported |
| IDE extensions (VS Code etc.) | ❓ | May work if they invoke the Claude Code CLI internally (not officially supported) |

### Network / communication

| Item | Value |
|---|---|
| Internal communication | Local HTTP (`127.0.0.1:47600`, falls back to 47601-47610 on conflict) |
| External transmission | **None** (no data is sent to any external server, including Anthropic) |
| Firewall | No special configuration needed (local-only) |
| Proxy | Not affected (local-only) |

### Verified environment

| Item | Value |
|---|---|
| Last verified | 2026-05-20 |
| Verified version | 0.9.74 |
| Verified OS | Windows 10 Pro 22H2 (x64) |

---

## Privacy / data handling

- **No external transmission**: Operation history, settings, and any generated data are stored only on the local machine. Nothing is sent to a server operated by the developer or any third party
- **Local communication only**: Integration with Claude Code uses an internal loopback (`127.0.0.1`) only. No Internet traffic
- **No telemetry / analytics**: There is no automatic transmission of usage stats or crash reports
- **What is stored**: settings (art / language / placement), per-session mascot position, tool permission dialog history, session IDs and working directories received via hooks (digest only — no body or credentials are kept)
- **Full clause**: see [EULA.md §4](EULA.md)

> Note: Claude Code itself communicates with Anthropic's servers. That is Claude Code's behavior, not this app's. Claude Code's own privacy policy applies.

---

## Uninstall

### How to uninstall

1. **Control Panel** → "**Programs and Features**" (or "Apps and Features") → select **kurotan** → "**Uninstall**"
2. Follow the prompts. The application body (`%LOCALAPPDATA%\Programs\kurotan\`) will be removed

### Data left behind after uninstall

| Location | After uninstall | Manual deletion |
|---|---|---|
| Application files | Removed automatically | — |
| User data (`%APPDATA%\kurotan\`) | **Remains** (so settings can be carried over on reinstall) | Delete the folder `%APPDATA%\kurotan` in Explorer |
| Claude Code hooks (`kurotan-notify` entries in `~/.claude/settings.json`) | **Remain** | Run `npm run uninstall-hooks` (source build) or use Settings → Hooks Installer → Uninstall before removing the app |

For a complete removal, delete the two locations above manually.

---

## Support / contact

- **Bugs / feature requests**: please file an issue on the distribution repository on GitHub
- **Do not contact Anthropic / Claude Code**: this is an **unofficial fan-made app** with no relation to Anthropic, PBC (see [EULA.md §5](EULA.md))

> This is free software. Support is best-effort and not guaranteed.

---

## Troubleshooting (FAQ)

### Q1. "Windows protected your PC" appears during install

This is a normal warning for unsigned binaries. Click "**More info**" → "**Run anyway**". See [SmartScreen notice](#smartscreen) for details.

### Q2. Kurotan doesn't appear when I launch Claude Code

Check in order:

1. **Is kurotan in the tray?** — if not, the app itself isn't running. Launch it from the Start menu
2. **Are the hooks installed?** — Settings → Hooks Installer should show "✓ installed"
3. **`~/.claude/settings.json` integrity** — if you use other tools, confirm the `kurotan-notify` hook lines are still present
4. **Port conflict** — make sure nothing else is using `127.0.0.1:47600` (kurotan falls back to 47601-47610)

### Q3. Kurotan is asleep and won't wake up

Hover the mouse cursor over the mascot to wake it. Sleep talk shows up while the cursor is *not* on the mascot.

### Q4. The app icon looks outdated

The Windows icon cache may be holding an old image. Restart `explorer.exe` from Task Manager, or run `ie4uinit.exe -show` from cmd.

### Q5. Can I use it commercially / redistribute it?

This app is **non-commercial / personal use only** per [EULA.md](EULA.md). Please avoid sales, paid distribution, ad integration, and in-app purchases. Forks are welcome within the MIT License — please credit the original repo.

### Q6. I'm worried about CPU / memory usage

Settings → "Close all mascots" hides every mascot while keeping the app resident — screen load drops to near zero. To stop completely, use Tray → "Exit".

### Q7. How do I switch languages?

Settings → Language. Supported: **日本語 / English / 简体中文 / 繁體中文 / 한국어** (5 languages).

---

## Known limitations

- macOS / Linux not supported (Windows only)
- Multi-display: primary monitor only
- Some art / effects are not currently available

---

## License

MIT License. See [LICENSE](LICENSE) for details.

This app is intended for **non-commercial / free distribution / personal use**. The app itself does not engage in any sales, paid distribution, ads, DLC, paid features, or tip jars. Use within the MIT license is permitted, but please follow the trademark handling rules in this README and [NOTICE.md](NOTICE.md) regarding Anthropic / Claude logos and word marks.

---

## Disclaimer

- This app is an **unofficial fan-made app, not affiliated with Anthropic PBC or the Claude Code project**.
- Anthropic and Claude are trademarks of Anthropic PBC. Naming is used here purely for identification and does not imply sponsorship, partnership, or endorsement.
- The visual inherits silhouette, color, and atmosphere from the Claude Code startup screen pixel mascot as fan-art. Anthropic / Claude logos and word marks are not directly embedded.
- If notified by Anthropic, the developer will promptly stop distribution, adjust the design, or rename the app as requested.
- The developer is not liable for any damages arising from the use of this app.
