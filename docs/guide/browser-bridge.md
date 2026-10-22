# Browser Bridge Setup

> **⚠️ Important**: Browser commands reuse your Chrome login session. You must be logged into the target website in Chrome before running commands.

byCLI connects to your browser through a lightweight **Browser Bridge** Chrome Extension + micro-daemon (zero config, auto-start).

## Extension Installation

### Method 1: Download Pre-built Release (Recommended)

1. Go to the GitHub [Releases page](https://github.com/sovovs/byCLI/releases) and download the latest `bycli-extension-v{version}.zip`.
2. Unzip the file and open `chrome://extensions`, enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the unzipped folder.

### Method 2: Load Unpacked Source (For Developers)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory from the repository.

## Verification

That's it! The daemon auto-starts when you run any browser command. No tokens, no manual configuration.

```bash
bycli doctor            # Check extension + daemon connectivity
```

## Tab Targeting

Browser commands require an explicit `<session>` positional immediately after `browser`. Use the same session name for a multi-step flow, and use different names to isolate parallel work.

```bash
bycli browser baidu open https://www.baidu.com/
bycli browser baidu tab list
bycli browser baidu tab new https://www.baidu.com/
bycli browser baidu eval --tab <targetId> 'document.title'
bycli browser baidu tab select <targetId>
bycli browser baidu get title
bycli browser baidu tab close <targetId>
```

Key rules:

- `bycli browser <session> open <url>` and `bycli browser <session> tab new [url]` return a `targetId`.
- `bycli browser <session> tab list` prints the `targetId` values of tabs that already exist.
- `--tab <targetId>` routes a single browser command to that specific tab.
- `tab new` creates a new tab but does not change the default browser target.
- `tab select <targetId>` makes that tab the default target for later untargeted `bycli browser ...` commands.
- `tab close <targetId>` removes the tab; if it was the current default target, the stored default is cleared.

## Session Lifecycle

Use a stable session name when you want multiple `bycli browser` commands to keep operating on the same page:

```bash
bycli browser my-session open https://example.com
bycli browser my-session state
bycli browser my-session extract "main"
```

Owned browser sessions use an interactive tab lease with a 10-minute idle timeout. Release it explicitly when done:

```bash
bycli browser my-session close
```

Use `bycli browser <session> bind` when you want to attach byCLI to a Chrome tab you already opened manually. Bound sessions do not have the owned-session idle close timer; they stay attached until `unbind`, tab close, window close, or daemon restart. For owned sessions, use `--window foreground` to watch byCLI work in a visible automation window, or `--window background` to keep that automation window out of the way.

## How It Works

```
┌─────────────┐     WebSocket      ┌──────────────┐     Chrome API     ┌─────────┐
│  bycli    │ ◄──────────────► │  micro-daemon │ ◄──────────────► │  Chrome  │
│  (Node.js)  │    localhost:19825  │  (auto-start) │    Extension       │ Browser  │
└─────────────┘                    └──────────────┘                    └─────────┘
```

The daemon manages the WebSocket connection between your CLI commands and the Chrome extension. The extension executes JavaScript in the context of web pages, with access to the logged-in session.

## Daemon Lifecycle

The daemon auto-starts on first browser command and stays alive persistently.

```bash
bycli daemon stop      # Graceful shutdown
```

The daemon is persistent — it stays alive until you explicitly stop it (`bycli daemon stop`) or uninstall the package.

## Running byCLI from a remote machine

If you need to run `bycli` on a remote server (CI runner, agent host) but keep the browser session on your local machine, see [Remote Orchestration](/guide/remote-orchestration). It walks through the SSH reverse-tunnel pattern so the daemon never leaves localhost.

## Verify executing extension code

CLI and extension versions are independent. A matching manifest version alone does not establish which background bundle the browser is executing. Extension builds include `dist/build-info.json`; the running worker reports its embedded build ID in its handshake. `bycli doctor --json` compares that ID with the installed package and verifies the package's script digest. A missing ID is unverified, not proof of stale cache. A mismatch requires reloading the extension or restarting the managed browser; restarting the daemon alone does not reload Chromium code.

Doctor also reports the bundled extension's version and absolute directory separately from the connected version and release-update hints. This directory identifies the local build you can load; it is not proof of the browser's existing load path. File-upload readiness requires the connected profile to advertise `file-input-shadow-v1`. Generic connectivity and a matching build ID do not establish that capability, and capability readiness does not prove that a platform accepted an upload. Missing capabilities produce a warning and a nonzero doctor exit status. Reload through the browser's normal extension manager, then rerun doctor before retrying an operation with a recorded no-injection receipt. A site-access denial must be resolved in the relevant tool permissions; switching control channels is not a recovery step.

`bycli doctor --diagnostics <new-directory>` saves a private `bridge-diagnostics.json` containing versions, build identities, connection state and capabilities. It omits cookies, page content and media. Keep the original operation journal for publishing failures. Do not delete a browser profile or operation to make a retry possible.

Native upload returns success only when the selected FileList can be verified. This confirms file selection, not platform acceptance. `UPLOAD_NOT_STARTED` means the file injection was not dispatched; `UPLOAD_RESULT_UNKNOWN` requires inspecting the platform before any retry. Native file injection is not automatically replayed after a lost response. The bridge advertises `file-input-shadow-v1` for the dedicated open-shadow upload path. Direct CDP backends use the same uniqueness and file-input checks; closed shadows and iframe boundaries are not crossed implicitly.

After changing extension code, increase both `extension/package.json` and `extension/manifest.json` versions before release. Build and package the extension together so its runtime ID, script digest and manifest agree. Release packaging rejects inconsistent metadata.

An isolated native-upload smoke test is available after `npm run build && npm run build:extension`:

```bash
BYCLI_UPLOAD_E2E=1 CHROME_PATH='<extension-capable Chromium executable>' \
  npx vitest run --project e2e tests/e2e/browser-upload-local.test.ts
```

It uses a private daemon port, a disposable profile and about:blank fixtures, and exercises nested open shadows through the actual extension. It does not establish acceptance by a publishing platform.

原生文件注入返回成功后，页面可能立即消费或替换 input；即时 FileList 为空只标记 `file_list_verified=false`，不自动重传，也不单独判定平台失败。`uploaded=true` 表示原生注入已返回成功，`files` 为注入文件数、`file_names` 为当时观察到的名称；封面仍须通过自定义图片、裁剪器绑定、确认和卡片身份核验后才能保存。
