# Hermes — Cursor Delegate

Delegate coding work from **Hermes Agent** to **Cursor's local agent**
with model `composer-2` via ACP (Agent Client Protocol).

The Cursor agent edits files on disk directly under the working directory —
use a clean branch and review diffs before committing.

## How it works

```
Hermes ←→ (MCP stdio) ←→ cursor-mcp-server.js ←→ (ACP stdio) ←→ cursor agent acp
```

A thin Node.js bridge translates Hermes's MCP tool calls into Cursor's ACP
protocol. The whole connection is persistent — one ACP process stays alive
across multiple tool calls, with optional session resume.

## Requirements

- [Cursor](https://cursor.com) installed and **logged in**
  (`cursor agent login` if not yet done)
- Node.js 20+ (22 recommended)
- No API key — uses Cursor's existing login via `~/.cursor/cli-config.json`

## Install

```bash
cd ~/.hermes/integrations/hermes-cursor-delegate
npm install
```

That's it — no `.env`, no API key.

## Hermes Wiring (MCP)

Register the bridge as an MCP server:

```bash
hermes mcp add cursor-agent \
  --command "node ~/.hermes/integrations/hermes-cursor-delegate/src/cursor-mcp-server.js"
```

After registration, Hermes discovers the `cursor_agent_code` tool in every
new session. Use `/reset` if already running.

### Tool: `cursor_agent_code`

```json
{
  "prompt": "string (required) — the coding task",
  "repo_path": "string (optional) — override working directory",
  "resume_session": "boolean (optional) — continue previous conversation"
}
```

### Verify

```bash
hermes mcp test cursor-agent
hermes mcp list
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `CURSOR_REPO` | Optional. Absolute path to working directory. |
| `HERMES_CURSOR_REPO` | Fallback alias for `CURSOR_REPO`. |

**Resolution order:** `repo_path` arg → `CURSOR_REPO` → `HERMES_CURSOR_REPO` →
git repo root from cwd → cwd.

## Session Persistence

Set `resume_session: true` to keep conversation context across prompts.
The bridge caches the session per-repo-path, so the next prompt to the
same repo picks up where the last one left off — the agent remembers
architecture, conventions, and prior work.

## Safety

- The Cursor agent **edits files on disk directly**.
- Permission requests are auto-approved (equivalent to Cursor IDE's agent
  mode — `cursor agent --yolo`).
- Always use a clean branch before delegating:
  ```bash
  git checkout -b cursor-agent-work
  ```
- Review diffs before committing.

## Project Structure

```
~/.hermes/integrations/hermes-cursor-delegate/
├── package.json              # ESM package (zero external deps)
├── README.md                 # This file
└── src/
    ├── acp-client.js         # ACP protocol client (persistent connection)
    └── cursor-mcp-server.js  # stdio MCP server (protocol bridge)
```
