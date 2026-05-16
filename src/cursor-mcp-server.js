#!/usr/bin/env node

/**
 * cursor-mcp-server.js
 *
 * stdio MCP server that exposes Cursor's composer-2 agent as a tool
 * via the Agent Client Protocol (ACP).
 *
 * Architecture:
 *   Hermes ←→ (stdio MCP) ←→ cursor-mcp-server.js ←→ (stdio ACP) ←→ cursor agent acp
 *
 * Register with Hermes:
 *   hermes mcp add cursor-agent \
 *     --command "node ~/.hermes/integrations/hermes-cursor-delegate/src/cursor-mcp-server.js"
 *
 * Protocol: JSON-RPC 2.0 over stdio.
 */

import { AcpClient } from "./acp-client.js";
import { createInterface } from "node:readline";
import process from "node:process";

// ── Protocol helpers ─────────────────────────────────────────────────────────

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendProgress(id, progress, total, message) {
  sendMessage({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: id, progress, total, message },
  });
}

// ── Tool definition ──────────────────────────────────────────────────────────

const TOOL = {
  name: "cursor_agent_code",
  description:
    "Delegate a coding task to Cursor's local agent with model composer-2. " +
    "The agent edits files on disk under the working directory. " +
    "Uses Cursor's existing login — no API key needed. " +
    "Supports session persistence: set resume_session=true to continue " +
    "the previous conversation for the same repo_path.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The coding task prompt. Be specific and self-contained.",
      },
      repo_path: {
        type: "string",
        description:
          "Optional. Absolute path to the repo to work in. " +
          "Defaults to CURSOR_REPO env var, then HERMES_CURSOR_REPO, " +
          "then git root from cwd, then cwd.",
      },
      resume_session: {
        type: "boolean",
        description:
          "Optional. If true, resume the existing session for this " +
          "repo_path instead of creating a new one. The agent retains " +
          "conversation context across prompts.",
        default: false,
      },
    },
    required: ["prompt"],
  },
};

// ── Server state ─────────────────────────────────────────────────────────────

let acp = null;
let sessionCache = new Map(); // repoPath -> sessionId
let initialized = false;

// ── Resolve working directory ────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

function resolveCwd(repoPath) {
  if (repoPath) {
    if (!existsSync(repoPath)) {
      throw new Error(`repo_path does not exist: ${repoPath}`);
    }
    return repoPath;
  }

  const envPath = process.env.CURSOR_REPO || process.env.HERMES_CURSOR_REPO || "";
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`CURSOR_REPO directory does not exist: ${envPath}`);
    }
    return envPath;
  }

  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (root) return root;
  } catch {}

  return process.cwd();
}

// ── Handle ACP operations ────────────────────────────────────────────────────

async function ensureSession(repoPath, resume = false) {
  const cacheKey = repoPath;

  if (resume && sessionCache.has(cacheKey)) {
    const sessionId = sessionCache.get(cacheKey);
    try {
      await acp.loadSession(sessionId, repoPath);
      return sessionId;
    } catch {
      sessionCache.delete(cacheKey);
    }
  }

  const sessionId = await acp.createSession(repoPath);
  sessionCache.set(cacheKey, sessionId);
  return sessionId;
}

async function runPrompt(prompt, repoPath, resume = false) {
  const sessionId = await ensureSession(repoPath, resume);
  const { updates } = await acp.sendPrompt(sessionId, prompt);

  // Reconstruct text from agent_message_chunk updates
  const textChunks = [];
  for (const update of updates) {
    if (update?.update?.sessionUpdate === "agent_message_chunk") {
      const content = update.update.content;
      if (content?.type === "text" && content.text) {
        textChunks.push(content.text);
      }
    }
  }

  return { sessionId, text: textChunks.join("") };
}

// ── Handle incoming MCP requests ─────────────────────────────────────────────

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    case "initialize": {
      // Start the ACP connection to cursor
      try {
        acp = new AcpClient();
        await acp.start();
        initialized = true;

        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "cursor-agent-delegate",
            version: "1.0.0",
          },
        });
      } catch (err) {
        sendError(id, -32000, `Failed to start Cursor ACP: ${err.message}`);
      }
      break;
    }

    case "notifications/initialized":
      break;

    // ── Tools ───────────────────────────────────────────────────────────────
    case "tools/list": {
      sendResponse(id, { tools: [TOOL] });
      break;
    }

    case "tools/call": {
      if (!initialized || !acp) {
        sendError(id, -32000, "Server not initialized. Call initialize first.");
        break;
      }

      const { name, arguments: args } = params || {};

      if (name !== TOOL.name) {
        sendError(id, -32601, `Unknown tool: ${name}`);
        break;
      }

      const prompt = args?.prompt;
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        sendError(id, -32602, "Missing required argument: prompt (string)");
        break;
      }

      const repoPath = resolveCwd(
        typeof args?.repo_path === "string" ? args.repo_path.trim() : undefined
      );
      const resume = args?.resume_session === true;

      try {
        sendProgress(id, 0, 1, "Starting Cursor agent...");

        const { sessionId, text } = await runPrompt(
          prompt.trim(),
          repoPath,
          resume
        );

        sendResponse(id, {
          content: [{ type: "text", text: text || "(no output)" }],
          isError: false,
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: err.message || String(err) }],
          isError: true,
        });
      }
      break;
    }

    // ── Shutdown ────────────────────────────────────────────────────────────
    case "shutdown": {
      if (acp) await acp.stop();
      sendResponse(id, null);
      break;
    }

    case "exit": {
      if (acp) await acp.stop();
      process.exit(0);
      break;
    }

    default: {
      sendError(id, -32601, `Method not found: ${method}`);
      break;
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    handleRequest(JSON.parse(trimmed));
  } catch {
    sendMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
});

rl.on("close", async () => {
  if (acp) await acp.stop();
  process.exit(0);
});
