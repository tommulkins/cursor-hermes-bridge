# cursor-hermes-bridge

Bridge [Hermes Agent](https://hermes-agent.nousresearch.com) to **Cursor's composer-2 agent** via the **Agent Client Protocol (ACP)**. No API key needed — uses Cursor's existing login.

## Why

Hermes and Cursor are both powerful agents, but they speak different protocols:

| Side | Protocol | Role |
|---|---|---|
| Hermes | **MCP** (Model Context Protocol) | Native tool integration — `hermes mcp add` |
| Cursor | **ACP** (Agent Client Protocol) | Agent-to-client communication — `cursor agent acp` |

This bridge translates between them. It lets Hermes hand off "serious coding" work to Cursor's composer-2 — the same model that powers Cursor's IDE — without opening a TUI, managing API keys, or blocking Hermes from working on other things.

Before this bridge, the alternatives were:
- `cursor agent --print` — one-shot CLI calls, no session persistence, blind `--yolo` permissions
- `@cursor/sdk` — required a separate API key from cursor.com/dashboard/integrations

ACP solves all of that: persistent sessions, streaming progress, permission-aware tool execution, and connection reuse across multiple prompts.

## Architecture

```
┌──────────────┐     MCP (stdio)      ┌──────────────────┐     ACP (stdio)      ┌────────────────┐
│              │ ◄──────────────────► │                  │ ◄──────────────────► │                │
│   Hermes     │                      │  cursor-hermes-  │                      │  cursor agent  │
│   Agent      │                      │  bridge          │                      │  acp           │
│              │                      │  (Node.js MCP    │                      │                │
│              │                      │   server)        │                      │                │
└──────────────┘                      └──────────────────┘                      └────────────────┘
                                            │
                                     JSON-RPC 2.0
                                     newline-delimited
                                     bidirectional
```

Hermes sees a standard MCP tool called `cursor_agent_code`. Behind the scenes, the bridge:

1. Spawns `cursor agent acp` as a persistent child process
2. Authenticates using the existing Cursor login (`~/.cursor/cli-config.json`)
3. Creates sessions via ACP's `session/new` with the target working directory
4. Sends prompts as `ContentBlock[]` arrays via `session/prompt`
5. Collects `session/update` notifications (agent message chunks)
6. Auto-approves `session/request_permission` notifications
7. Reconstructs the final response text and returns it to Hermes

Sessions are cached per repository path. Setting `resume_session: true` loads the previous session, preserving conversation context across prompts — the agent remembers project architecture, conventions, and prior work.

## Requirements

- [Cursor](https://cursor.com) installed and logged in (`cursor agent login`)
- [Hermes Agent](https://hermes-agent.nousresearch.com) installed
- Node.js 20+
- No API key

## Quick Start

```bash
# Clone
git clone https://github.com/tommulkins/cursor-hermes-bridge.git ~/.hermes/integrations/cursor-hermes-bridge
cd ~/.hermes/integrations/cursor-hermes-bridge

# No dependencies to install — it's pure Node.js stdlib
```

Register with Hermes:

```bash
hermes mcp add cursor-agent \
  --command node \
  --args /absolute/path/to/cursor-hermes-bridge/src/cursor-mcp-server.js
```

After registration, `cursor_agent_code` appears as a tool in every new Hermes session (`/reset` if already running).

## Usage

### Tool: `cursor_agent_code`

| Argument | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The coding task. Be specific and self-contained. |
| `repo_path` | string | no | Working directory. Defaults to git root from cwd, then cwd. |
| `resume_session` | boolean | no | Continue the previous session for this repo (default: false). |

### Example

In a Hermes session:

> Use cursor_agent_code to refactor the rate limiter in src/middleware/auth.ts to use async/await

### Environment variables

| Variable | Purpose |
|---|---|
| `CURSOR_REPO` | Override working directory (takes precedence over `repo_path` arg). |
| `HERMES_CURSOR_REPO` | Fallback alias for `CURSOR_REPO`. |

### Verify

```bash
hermes mcp test cursor-agent
```

## ACP Protocol Details

The bridge implements the [Agent Client Protocol](https://agentclientprotocol.com/) — JSON-RPC 2.0 over stdio, one message per line.

**Sequence:**

1. `initialize` — negotiate protocol version (v1)
2. `authenticate` — method `cursor_login` (uses stored credentials)
3. `session/new` — requires `{ cwd: string, mcpServers: [] }`
4. `session/prompt` — prompt is `ContentBlock[]`, e.g. `[{ type: "text", text: "..." }]`
5. `session/update` notifications carry `agent_message_chunk` with incremental text
6. `session/request_permission` — bridge responds `allow-always`

## Improvements Needed

See the [issues](https://github.com/tommulkins/cursor-hermes-bridge/issues) page for planned work:

- ACP process crash recovery (auto-restart)
- Streaming progress via MCP notifications
- Configurable model selection
- Git worktree isolation per task
- Graceful shutdown of ACP child process
- Concurrent session support

## License

MIT
