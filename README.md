# pi-agy

> **Google Antigravity (`agy` CLI) Provider & Native Agent Bridge for [Pi Coding Agent](https://pi.dev)**

`pi-agy` connects the [Pi Coding Agent](https://github.com/earendil-works/pi) directly to your local Google Antigravity runtime (`agy`), giving you access to frontier models (Gemini 3.1 Pro, Gemini 3.8 Flash, Claude Sonnet) with native subagents, tool execution cards, and persistent session trees.

---

## ✨ Features

- **🛡️ 100% Safe (No Scraping / No Unofficial OAuth):** Communicates directly with your authenticated local `agy` binary over standard input/output streams (`--input-format stream-json`). No third-party token handling or scraping that risks Google account bans.
- **🚀 Frontier Models:** Access Gemini 3.1 Pro (High/Low reasoning), Gemini 3.8/3.7 Flash, and Claude models available through your local Antigravity environment.
- **📦 Native TUI Tool Cards:** Displays file reads, edits, terminal commands, and subagent delegations inside Pi's native terminal UI with duration, status badges, and `Ctrl+O` expanders.
- **🔗 Bidirectional Session Linking:** Pairs Pi session files (`.jsonl`) with Antigravity SQLite conversation trees (`~/.gemini/antigravity-cli/brain/`), enabling seamless continuation and inspection.
- **🔄 Auto-Healing & 503 Capacity Fallback:** If Google's Flash servers report temporary 503 capacity limits, `pi-agy` automatically falls back to Gemini 3.1 Pro without aborting your prompt.
- **⚡ Smart Context & Delta Sync:** Automatically detects Pi context compactions, filters noise, and synchronizes only recent turns to avoid giant prompt dumps.

---

## 📋 Requirements

1. **[Pi Coding Agent](https://pi.dev)** (`>= 0.80.0`)
2. **Google Antigravity CLI (`agy`)** installed and authenticated (`~/.local/bin/agy` or in your `$PATH`).
3. **Node.js** (`>= 22.0.0`).

---

## 📥 Installation

You can install `pi-agy` globally or per-project using Pi's package manager:

### Via Git (GitHub)
```bash
pi install git:github.com/pauli/pi-agy
```

### Via NPM (once published)
```bash
pi install npm:pi-agy
```

### From Local Source (development)
```bash
pi install /path/to/pi-agy
```

To test without permanently installing:
```bash
pi -e /path/to/pi-agy
```

---

## 🎯 Usage

Once installed, select any Antigravity model using `/model` inside Pi, or start Pi directly:

```bash
# Start Pi with Gemini 3.8 Flash
pi --model antigravity:gemini-3.8-flash-high

# Start Pi with Gemini 3.1 Pro (Deep Reasoning)
pi --model antigravity:gemini-3.1-pro-high
```

### Available Models & Aliases

| Model ID | Alias | Reasoning | Context Window |
| :--- | :--- | :--- | :--- |
| `gemini-3.8-flash-high` | `gemini-flash` | Yes (High) | 1,048,576 |
| `gemini-3.8-flash-medium` | - | Yes (Med) | 1,048,576 |
| `gemini-3.8-flash-low` | - | Yes (Low) | 1,048,576 |
| `gemini-3.1-pro-high` | `gemini-pro` | Yes (High) | 1,048,576 |
| `gemini-3.1-pro-low` | - | Yes (Low) | 1,048,576 |
| `claude-sonnet-4-6` | `sonnet` | Yes | 200,000 |
| `claude-opus-4-6-thinking` | `opus` | Yes | 200,000 |
| `gpt-oss-120b-medium` | `oss` | Yes | 131,072 |

---

## 🛠️ Slash Commands

`pi-agy` adds several commands to Pi for managing conversation state:

- `/agy-models` — Lists all available Antigravity models, context windows, and active aliases.
- `/agy-status` — Displays current session link status, active conversation ID, message sync offset, and SQLite state.
- `/agy-sync` — Forces re-synchronization of Pi's conversation state to the native Antigravity conversation.
- `/agy-link <convId>` — Manually attaches the current Pi session to an existing Antigravity conversation ID.

---

## 🧱 Architecture

```
┌─────────────────────────┐          stdio (stream-json)          ┌───────────────────────────┐
│     Pi Coding Agent     │ ◄───────────────────────────────────► │  Google Antigravity (agy) │
│                         │                                       │                           │
│  - Interactive TUI      │                                       │  - Autonomous Subagents   │
│  - Tool Card Renderers  │                                       │  - Sandbox Execution      │
│  - Session History      │                                       │  - SQLite Transcripts     │
└─────────────────────────┘                                       └───────────────────────────┘
             ▲                                                                  ▲
             │                                                                  │
             └────────────── ~/.pi/agent/antigravity-sessions.json ─────────────┘
```

1. **Zero-Execution Host Bridge:** Tools executed by Antigravity are streamed and captured in real-time. Pi renders formatted TUI entries (`agy_tool`) without running duplicate commands locally.
2. **Session Persistence:** State mapping between Pi's session JSONL and Antigravity's internal UUIDs is tracked in `~/.pi/agent/antigravity-sessions.json`.

---

## 📄 License

[MIT](LICENSE)
