#!/usr/bin/env node

/**
 * acp-client.js
 *
 * Manages a persistent ACP (Agent Client Protocol) connection to
 * `cursor agent acp`. Handles the full lifecycle:
 *   initialize → authenticate → session/create → session/prompt
 *
 * JSON-RPC 2.0 over stdio, one message per line.
 * Spec: https://agentclientprotocol.com/
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

// ── Helpers ──────────────────────────────────────────────────────────────────

let requestId = 0;

function nextId() {
  return ++requestId;
}

// ── ACP Client ───────────────────────────────────────────────────────────────

export class AcpClient {
  constructor({ log = false } = {}) {
    this.log = log;
    this.child = null;
    this.stdin = null;
    this.readline = null;
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    this.notificationHandlers = new Map(); // method -> Set<handler>
    this._closed = false;
    this._buffer = "";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the cursor agent acp subprocess.
   * Resolves when the ACP initialize response is received.
   */
  async start() {
    const cursorPath = await this._findCursor();
    this._debug(`Spawning: ${cursorPath} agent acp`);

    this.child = spawn(cursorPath, ["agent", "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.stdin = this.child.stdin;

    // Read stderr for diagnostics (write to our stderr)
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[cursor-acp] ${chunk.toString()}`);
    });

    // Read stdout — JSON-RPC responses
    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => this._onMessage(line.trim()));

    // Handle unexpected exit
    this.child.on("exit", (code, signal) => {
      this._debug(`cursor agent acp exited (code=${code}, signal=${signal})`);
      this._rejectAllPending(new Error(`ACP process exited: code=${code} signal=${signal}`));
    });

    this.child.on("error", (err) => {
      this._debug(`ACP process error: ${err.message}`);
      this._rejectAllPending(err);
    });

    // Wait for initialize response
    return this._initialize();
  }

  /**
   * Stop the ACP subprocess gracefully.
   */
  async stop() {
    this._closed = true;
    if (this.child) {
      try {
        await this._send("shutdown", {});
      } catch {
        // Process may already be dead
      }
      this.child.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
      }, 2000);
    }
    if (this.readline) this.readline.close();
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create a new agent session.
   * @param {"agent" | "plan" | "ask"} mode
   * @returns {string} session ID
   */
  async createSession(cwd) {
    const result = await this._send("session/new", {
      cwd: cwd || process.cwd(),
      mcpServers: [],
    });
    this._debug(`Session created: ${result.sessionId}`);
    return result.sessionId;
  }

  /**
   * Load an existing session by ID.
   * @param {string} sessionId
   */
  async loadSession(sessionId, cwd) {
    await this._send("session/load", {
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: [],
    });
    this._debug(`Session loaded: ${sessionId}`);
  }
  /**
   * Send a prompt to the current session. Resolves when the agent finishes.
   * Updates from the agent stream are collected and returned.
   * Permission requests are auto-approved.
   * @param {string} sessionId
   * @param {string} prompt
   * @returns {Promise<{updates: object[], result: object}>}
   */
  async sendPrompt(sessionId, prompt) {
    this._debug(`Prompting session ${sessionId}: "${prompt.substring(0, 80)}..."`);

    const allUpdates = [];
    const handler = (params) => { allUpdates.push(params); };
    this.onNotification("session/update", handler);

    try {
      const result = await this._send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      return { updates: allUpdates, result };
    } finally {
      this.offNotification("session/update", handler);
    }
  }

  /**
   * Cancel the current prompt in a session.
   */
  async cancelPrompt(sessionId) {
    await this._send("session/cancel", { sessionId });
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  onNotification(method, handler) {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }
    this.notificationHandlers.get(method).add(handler);
  }

  offNotification(method, handler) {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _initialize() {
    const result = await this._send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "hermes-cursor-bridge", version: "1.0.0" },
    });
    this._debug(`ACP initialized: ${JSON.stringify(result)}`);

    // Now authenticate using cursor's existing login
    await this._send("authenticate", { methodId: "cursor_login" });
    this._debug("ACP authenticated via cursor_login");

    return result;
  }

  async _send(method, params = {}) {
    if (this._closed) throw new Error("ACP client is closed");

    const id = nextId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out (method: ${method}, id: ${id})`));
      }, 600_000); // 10 minute timeout

      this.pending.set(id, { resolve, reject, timer, method });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.stdin.write(msg);
      this._debug(`→ ${method} (id: ${id})`);
    });
  }

  _onMessage(line) {
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._debug(`← (unparseable): ${line.substring(0, 100)}`);
      return;
    }

    // Notification (no id)
    if (msg.id === undefined || msg.id === null) {
      this._handleNotification(msg);
      return;
    }

    // Response
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this._debug(`← (orphan response id=${msg.id}): ${JSON.stringify(msg).substring(0, 120)}`);
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      this._debug(`← ERROR ${pending.method} (id: ${msg.id}): ${msg.error.message}`);
      pending.reject(new Error(`ACP ${pending.method}: ${msg.error.message}`));
    } else {
      this._debug(`← OK ${pending.method} (id: ${msg.id})`);
      pending.resolve(msg.result);
    }
  }

  _handleNotification(msg) {
    const { method, params } = msg;
    this._debug(`← NOTIFY ${method}`);

    // Check for permission requests — auto-approve
    if (method === "session/request_permission") {
      this._handlePermissionRequest(params);
      return;
    }

    // Forward to registered handlers
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(params); } catch (err) {
          process.stderr.write(`[acp-client] handler error for ${method}: ${err}\n`);
        }
      }
    }
  }

  _handlePermissionRequest(params) {
    // Auto-approve all tool requests (equivalent to --yolo but through ACP)
    const response = {
      jsonrpc: "2.0",
      id: params.requestId || nextId(),
      result: { decision: "allow-always" },
    };
    this.stdin.write(JSON.stringify(response) + "\n");
    this._debug(`→ AUTO-APPROVED permission request`);
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  async _findCursor() {
    // Check common paths
    const candidates = ["cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"];
    const { access } = await import("node:fs/promises");
    for (const cmd of candidates) {
      try {
        // Simple existence check
        const { execSync } = await import("node:child_process");
        execSync(`${cmd} --version`, { stdio: "ignore", timeout: 3000 });
        return cmd;
      } catch {
        continue;
      }
    }
    throw new Error(
      "Cursor CLI not found.\n" +
        "  Install from https://cursor.com or ensure `cursor` is on your PATH.\n" +
        "  Then run: cursor agent login"
    );
  }

  _debug(msg) {
    if (this.log) {
      process.stderr.write(`[acp-client] ${msg}\n`);
    }
  }
}
