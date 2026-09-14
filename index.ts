import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function findAgyBin(): string {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  const userLocal = path.join(os.homedir(), ".local/bin/agy");
  if (fs.existsSync(userLocal)) return userLocal;
  try {
    const out = execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return userLocal;
}

const AGY_BIN = findAgyBin();
const AGY_DIR = process.env.AGY_DIR || path.join(os.homedir(), ".gemini/antigravity-cli");
const AGY_CONVERSATIONS_DIR = path.join(AGY_DIR, "conversations");
const AGY_BRAIN_DIR = path.join(AGY_DIR, "brain");
const AGY_SUMMARIES_DB = path.join(AGY_DIR, "conversation_summaries.db");
const SESSIONS_FILE = path.join(os.homedir(), ".pi/agent/antigravity-sessions.json");
const ERROR_DIR = path.join(os.homedir(), ".pi/agent/agy-errors");

// Hard wall-clock caps to prevent infinite hangs
const PROVIDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const TOOL_TIMEOUT_MS = 20 * 60 * 1000;     // 20 min
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;  // 20 min

// ─── Model catalog: 14 IDs from `agy models` ──────────────────────────────────
const ANTIGRAVITY_MODELS: Array<{
  id: string; name: string; reasoning: boolean;
  input: ("text")[]; contextWindow: number; maxTokens: number;
}> = [
  { id: "gemini-3.8-flash-high",   name: "Gemini 3.8 Flash (High)",   reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.8-flash-low",    name: "Gemini 3.8 Flash (Low)",    reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.7-flash-high",   name: "Gemini 3.7 Flash (High)",   reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.7-flash-low",    name: "Gemini 3.7 Flash (Low)",    reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.6-flash-high",   name: "Gemini 3.6 Flash (High)",   reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.6-flash-low",    name: "Gemini 3.6 Flash (Low)",    reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.1-pro-high",     name: "Gemini 3.1 Pro (High)",     reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "gemini-3.1-pro-low",      name: "Gemini 3.1 Pro (Low)",      reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "claude-sonnet-4-6",       name: "Claude Sonnet 4.6 (Thinking)", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 64000 },
  { id: "gpt-oss-120b-medium",     name: "GPT-OSS 120B (Medium)",     reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 32768 },
];

const VALID_IDS = new Set(ANTIGRAVITY_MODELS.map((m) => m.id));

const ALIASES: Record<string, string> = {
  "gemini-pro":       "gemini-3.1-pro-high",
  "gemini-flash":     "gemini-3.8-flash-high",
  "sonnet":           "claude-sonnet-4-6",
  "opus":             "claude-opus-4-6-thinking",
  "oss":              "gpt-oss-120b-medium",
  "gemini-3.8-flash": "gemini-3.8-flash-high",
  "gemini-3.7-flash": "gemini-3.7-flash-high",
  "gemini-3.6-flash": "gemini-3.6-flash-high",
  "gemini-3.1-pro":   "gemini-3.1-pro-high",
};

function resolveModel(id: string, effort?: string): string {
  if (VALID_IDS.has(id)) return id;
  const alias = ALIASES[id];
  if (alias && VALID_IDS.has(alias)) return alias;
  if (effort && ["low", "medium", "high"].includes(effort)) {
    const candidate = `${id.replace(/-(low|medium|high)$/, "")}-${effort}`;
    if (VALID_IDS.has(candidate)) return candidate;
  }
  throw new Error(`Unknown agy model "${id}". Valid IDs: ${[...VALID_IDS].join(", ")}`);
}

// ─── Session-link state ──────────────────────────────────────────────────────
interface SessionLink {
  agyConvId: string;
  syncedCount: number;
  lastModel?: string;
  title?: string;
  updatedAt?: number;
}
interface SessionsState {
  v: number;
  links: Record<string, SessionLink>;
}

interface AgyToolCardData {
  tool: string;
  summary: string;
  output?: string;
  isError?: boolean;
  duration?: number;
}

let activePiSessionKey: string | undefined;
let activePiSessionCwd: string | undefined;
let currentUi: ExtensionUIContext | undefined;
let activeExtensionApi: ExtensionAPI | undefined;

function loadLinks(): SessionsState {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      if (raw && raw.v === 2 && raw.links && typeof raw.links === "object") {
        return raw as SessionsState;
      }
      try { fs.copyFileSync(SESSIONS_FILE, SESSIONS_FILE + ".bak"); } catch {}
    }
  } catch {}
  return { v: 2, links: {} };
}

function normalizeSessionKey(key: string): string {
  if (!key) return key;
  if (key.startsWith("ephemeral:")) return key;
  const base = path.basename(key);
  const match = base.match(/_([0-9a-fA-F-]+)\.jsonl$/);
  if (match) return match[1];
  return base.replace(/\.jsonl$/, "");
}

function getLink(state: SessionsState, key: string): SessionLink | undefined {
  if (!state?.links) return undefined;
  const norm = normalizeSessionKey(key);
  return state.links[norm] || state.links[key];
}

function saveLink(key: string, link: SessionLink) {
  if (key.startsWith("ephemeral:")) return;
  try {
    const state = loadLinks();
    const norm = normalizeSessionKey(key);
    state.links[norm] = link;
    if (norm !== key) {
      state.links[key] = link;
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

function dropLink(key: string) {
  if (key.startsWith("ephemeral:")) return;
  try {
    const state = loadLinks();
    const norm = normalizeSessionKey(key);
    delete state.links[norm];
    delete state.links[key];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

function detectConvIdFromSessionFile(filePath?: string): string | undefined {
  if (!filePath || filePath.startsWith("ephemeral:")) return undefined;
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    const bytesToRead = Math.min(stat.size, 128 * 1024);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }
    const tail = buf.toString("utf8");
    const brainMatch = tail.match(/brain\/([0-9a-fA-F-]{36})/g);
    if (brainMatch && brainMatch.length > 0) {
      const last = brainMatch[brainMatch.length - 1];
      const convId = last.replace("brain/", "");
      if (conversationExists(convId)) return convId;
    }
    const convMatch = tail.match(/"conversation_id"\s*:\s*"([0-9a-fA-F-]{36})"/g);
    if (convMatch && convMatch.length > 0) {
      const last = convMatch[convMatch.length - 1];
      const match = last.match(/"([0-9a-fA-F-]{36})"/);
      if (match && conversationExists(match[1])) return match[1];
    }
  } catch {}
  return undefined;
}

function getSafeSessionDir(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi/agent/sessions", safePath);
}

function findLatestPiSessionFile(cwd: string = process.cwd()): string | undefined {
  const sessionDir = getSafeSessionDir(cwd);
  try {
    if (!fs.existsSync(sessionDir)) return undefined;
    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = path.join(sessionDir, f);
        return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path;
  } catch {
    return undefined;
  }
}

function resolveSessionKey(options?: any): string {
  if (activePiSessionKey && !activePiSessionKey.startsWith("ephemeral:")) {
    return activePiSessionKey;
  }
  if (options?.sessionId && typeof options.sessionId === "string") {
    return options.sessionId;
  }
  const latest = findLatestPiSessionFile(activePiSessionCwd || process.cwd());
  if (latest) {
    activePiSessionKey = latest;
    return latest;
  }
  return `ephemeral:${process.pid}:${Date.now()}`;
}

function updateSessionContext(ctx: any) {
  if (!ctx) return;
  if (ctx.ui) currentUi = ctx.ui;
  if (ctx.cwd) activePiSessionCwd = ctx.cwd;
  const file = ctx.sessionManager?.getSessionFile?.();
  const id = ctx.sessionManager?.getSessionId?.();
  if (file) {
    activePiSessionKey = file;
  } else if (id && !activePiSessionKey) {
    activePiSessionKey = id;
  }
}

function logError(kind: string, transcript: string) {
  try {
    fs.mkdirSync(ERROR_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(ERROR_DIR, `${stamp}-${kind}.log`), transcript, "utf8");
  } catch {}
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals = "SIGKILL") {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch {}
  try { process.kill(pid, sig); } catch {}
}

// ─── Native AGY conversation helpers ──────────────────────────────────────────
interface AgyConversationSummary {
  id: string;
  title: string;
  preview: string;
  steps: number;
  modified: string;
  workspaces: string[];
}

function conversationExists(convId: string): boolean {
  if (!convId || !/^[0-9a-fA-F-]{8,}$/.test(convId)) return false;
  const dbFile = path.join(AGY_CONVERSATIONS_DIR, `${convId}.db`);
  const brainDir = path.join(AGY_BRAIN_DIR, convId);
  return fs.existsSync(dbFile) || fs.existsSync(brainDir);
}

function getAgyConversations(limit = 20): AgyConversationSummary[] {
  try {
    if (!fs.existsSync(AGY_SUMMARIES_DB)) return [];
    const db = new DatabaseSync(AGY_SUMMARIES_DB, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris 
        FROM conversation_summaries 
        ORDER BY last_modified_time DESC LIMIT ?
      `).all(Math.max(1, limit)) as any[];
      return rows.map((r) => {
        let ws: string[] = [];
        try { if (r.workspace_uris) ws = JSON.parse(r.workspace_uris); } catch {}
        return {
          id: r.conversation_id,
          title: r.title || "(Untitled)",
          preview: r.preview || "",
          steps: r.step_count || 0,
          modified: r.last_modified_time || "",
          workspaces: ws,
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function findAgyConversation(query: string): AgyConversationSummary | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const convs = getAgyConversations(50);
  const exact = convs.find((c) => c.id.toLowerCase() === q);
  if (exact) return exact;
  const byPrefix = convs.find((c) => c.id.toLowerCase().startsWith(q));
  if (byPrefix) return byPrefix;
  return convs.find((c) => c.title.toLowerCase().includes(q));
}

function cleanUserContent(raw: string): string {
  let text = raw || "";
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "");
  text = text.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "");
  text = text.replace(/^<USER_REQUEST>\s*/, "");
  text = text.replace(/\s*<\/USER_REQUEST>[\s\S]*$/, "");
  return text.trim();
}

function getAgyTranscript(convId: string): Array<{ role: "user" | "assistant"; text: string }> {
  const tFile = path.join(AGY_BRAIN_DIR, convId, ".system_generated/logs/transcript.jsonl");
  if (!fs.existsSync(tFile)) return [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  try {
    const content = fs.readFileSync(tFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === "USER_INPUT") {
          const cleaned = cleanUserContent(item.content);
          if (cleaned) turns.push({ role: "user", text: cleaned });
        } else if (item.type === "PLANNER_RESPONSE" && item.content) {
          turns.push({ role: "assistant", text: String(item.content).trim() });
        }
      } catch {}
    }
  } catch {}
  return turns;
}

function formatToolCallSummary(name: string, params?: any): string {
  if (!params || typeof params !== "object") return name;
  switch (name) {
    case "view_file":
      return `read ${path.basename(params.AbsolutePath || params.path || "")}`;
    case "run_command":
      return `bash ${(params.CommandLine || params.command || "").slice(0, 45)}`;
    case "replace_file_content":
      return `edit ${path.basename(params.TargetFile || params.path || "")}`;
    case "write_to_file":
      return `write ${path.basename(params.TargetFile || params.path || "")}`;
    case "grep_search":
      return `grep "${(params.Query || "").slice(0, 30)}"`;
    case "find_by_name":
      return `find "${params.Pattern || ""}"`;
    case "list_dir":
      return `ls ${path.basename(params.DirectoryPath || ".")}`;
    default:
      return name;
  }
}

function formatToolOutputSnippet(output: any): string {
  if (!output) return "";
  let text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  text = text.trim();
  if (!text) return "";
  const rawLines = text.split("\n");
  const maxLines = 5;
  const maxChars = 350;

  let truncated = rawLines.slice(0, maxLines).join("\n");
  if (truncated.length > maxChars) {
    truncated = truncated.slice(0, maxChars) + "...";
  }
  const lines = truncated.split("\n");
  const formattedLines = lines.map((l) => `>   ${l}`).join("\n");

  if (rawLines.length > maxLines || text.length > maxChars) {
    const remaining = Math.max(1, rawLines.length - maxLines);
    return `${formattedLines}\n>   ... (+${remaining} lines)`;
  }
  return formattedLines;
}

function formatToolCardTitle(name: string, params?: any): string {
  if (!params || typeof params !== "object") return name;
  switch (name) {
    case "run_command": {
      const cmd = params.CommandLine || params.command || "";
      return `$ ${cmd}`;
    }
    case "view_file": {
      const p = params.AbsolutePath || params.TargetFile || params.path || "";
      const base = path.basename(p);
      const lines = params.StartLine && params.EndLine ? `:${params.StartLine}-${params.EndLine}` : "";
      return `read ${base}${lines}`;
    }
    case "replace_file_content": {
      const p = params.TargetFile || params.path || "";
      const base = path.basename(p);
      const inst = params.Instruction ? ` (${params.Instruction.slice(0, 40)})` : "";
      return `edit ${base}${inst}`;
    }
    case "write_to_file": {
      const p = params.TargetFile || params.path || "";
      const base = path.basename(p);
      return `write ${base}`;
    }
    case "grep_search": {
      const q = params.Query || params.query || "";
      const sp = params.SearchPath ? path.basename(params.SearchPath) : ".";
      return `grep "${q}" in ${sp}`;
    }
    case "find_by_name": {
      const pat = params.Pattern || "";
      const sd = params.SearchDirectory ? path.basename(params.SearchDirectory) : ".";
      return `find "${pat}" in ${sd}`;
    }
    case "list_dir": {
      const dir = params.DirectoryPath ? path.basename(params.DirectoryPath) : ".";
      return `ls ${dir}`;
    }
    case "search_web":
    case "read_url_content": {
      const target = params.Url || params.query || params.Query || "";
      return `web ${target}`;
    }
    default: {
      const firstVal = Object.values(params)[0];
      const detail = firstVal ? ` ${String(firstVal).slice(0, 40)}` : "";
      return `${name}${detail}`;
    }
  }
}

function extractToolOutputText(output: any): string {
  if (!output) return "";
  if (typeof output === "string") return output.trim();
  if (output.Output && typeof output.Output === "string") return output.Output.trim();
  if (output.stdout && typeof output.stdout === "string") {
    let out = output.stdout;
    if (output.stderr) out += `\n[stderr]\n${output.stderr}`;
    return out.trim();
  }
  if (output.error && typeof output.error === "string") return output.error.trim();
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output).trim();
  }
}


// ─── Message formatting ──────────────────────────────────────────────────────
function extractContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}

function isNoise(text: string): boolean {
  return !text.trim() ||
    text.includes("RESOURCE_EXHAUSTED") ||
    text.includes("Too Many Requests");
}

function truncateItem(text: string): string {
  if (text.length <= 2500) return text.trim();
  return text.slice(0, 1800) + "\n...[truncated]...\n" + text.slice(-700);
}

function formatMessage(role: string, text: string): string {
  const label =
    role === "user" ? "USER" :
    role === "assistant" ? "ASSISTANT" :
    role === "tool" || role === "function" ? "TOOL RESULT" :
    role === "system" ? "SYSTEM" : role.toUpperCase();
  return `### ${label}:\n${truncateItem(text)}`;
}

function extractCurrentPrompt(context: Context): string {
  const messages = context.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const txt = extractContentText(messages[i].content);
      if (txt.trim()) return txt.trim();
    }
  }
  return "continuar";
}

function buildDelta(context: Context, fromIdx: number): string {
  const messages = context.messages || [];
  const parts: string[] = [];
  const MAX_DELTA_CHARS = 16000;
  let totalChars = 0;

  // Scan backwards from before the latest user message to only send recent context
  const endIdx = messages.length - 1;
  const startIdx = Math.max(fromIdx, endIdx - 6);

  for (let i = endIdx - 1; i >= startIdx; i--) {
    const msg = messages[i];
    const text = extractContentText(msg.content);
    if (isNoise(text)) continue;
    const formatted = formatMessage(msg.role, text);
    if (totalChars + formatted.length > MAX_DELTA_CHARS) break;
    parts.unshift(formatted);
    totalChars += formatted.length;
  }
  return parts.join("\n\n");
}

function buildFullHistory(context: Context): string {
  const messages = context.messages || [];
  const currentPrompt = extractCurrentPrompt(context);
  let lastUserIdx = messages.length - 1;
  while (lastUserIdx >= 0 && messages[lastUserIdx].role !== "user") lastUserIdx--;

  const parts: string[] = [];
  let totalChars = 0;
  const MAX_HISTORY_CHARS = 25000;

  const startIdx = Math.max(0, lastUserIdx - 10);
  for (let i = startIdx; i < lastUserIdx; i++) {
    const text = extractContentText(messages[i].content);
    if (isNoise(text)) continue;
    const formatted = formatMessage(messages[i].role, text);
    if (totalChars + formatted.length > MAX_HISTORY_CHARS) break;
    parts.push(formatted);
    totalChars += formatted.length;
  }

  const sections: string[] = [];
  if (
    context.systemPrompt &&
    !context.systemPrompt.includes("operating inside pi") &&
    !context.systemPrompt.includes("You are Pi") &&
    !context.systemPrompt.includes("coding agent harness")
  ) {
    sections.push(`[System Instructions]\n${truncateItem(context.systemPrompt)}`);
  }
  if (parts.length > 0) {
    sections.push(`[SESSION HISTORY — recent Pi context, oldest first]\n\n${parts.join("\n\n")}\n\n[END HISTORY]`);
  }
  sections.push(`================================================================================`);
  sections.push(`[CURRENT USER MESSAGE]:\n${truncateItem(currentPrompt)}`);
  return sections.join("\n\n");
}

// ─── Provider stream ─────────────────────────────────────────────────────────
function streamAntigravity(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    const runTurn = (
      promptToSend: string,
      agyModel: string,
      convId: string | undefined,
    ): Promise<{ convId: string | undefined; stderr: string; exitCode: number; timedOut: boolean; toolRunsCount: number }> =>
      new Promise((resolve, reject) => {
        const args = [
          "--dangerously-skip-permissions",
          "--model", agyModel,
          "--print-timeout", "25m",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
        ];
        if (convId && conversationExists(convId)) {
          args.push("--conversation", convId);
        }

        const proc = spawn(AGY_BIN, args, {
          cwd: activePiSessionCwd || process.cwd(),
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        let done = false;
        const finish = (val: { convId: string | undefined; stderr: string; exitCode: number; timedOut: boolean; toolRunsCount: number }) => {
          if (!done) { done = true; resolve(val); }
        };
        const fail = (err: unknown) => {
          if (!done) { done = true; reject(err); }
        };

        const pid = proc.pid;
        let timedOut = false;

        const watchdog = setTimeout(() => {
          timedOut = true;
          killGroup(pid, "SIGKILL");
        }, PROVIDER_TIMEOUT_MS);

        // Prevent uncaughtException on write EPIPE if process terminates early
        proc.stdin.on("error", () => {});

        if (options?.signal) {
          if (options.signal.aborted) {
            clearTimeout(watchdog);
            killGroup(pid, "SIGKILL");
            finish({ convId: undefined, stderr: "Aborted", exitCode: 1, timedOut: false, toolRunsCount: 0 });
            return;
          }
          options.signal.addEventListener("abort", () => {
            try { proc.stdin?.destroy(); } catch {}
            killGroup(pid, "SIGKILL");
          }, { once: true });
        }

        if (proc.stdin.writable && !proc.killed) {
          try {
            proc.stdin.write(JSON.stringify({
              event: "user",
              message: { content: promptToSend },
            }) + "\n");
            proc.stdin.end();
          } catch {}
        }

        let capturedError = "";
        let exitCode = 0;
        proc.stderr.on("data", (chunk) => { capturedError += chunk.toString(); });
        proc.on("error", (err) => { clearTimeout(watchdog); fail(err); });
        proc.on("close", (code) => { exitCode = code ?? 0; });

        const rl = readline.createInterface({ input: proc.stdout });
        let seenConvId: string | undefined;
        let toolRunsCount = 0;
        const activeToolSteps = new Map<number | string, { name: string; params: any; startTime: number }>();

        (async () => {
          try {
            for await (const line of rl) {
              if (options?.signal?.aborted) break;
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                const cid =
                  data.conversation_id ||
                  data.init?.conversation_id ||
                  data.step_update?.conversation_id ||
                  data.result?.conversation_id;
                if (cid) seenConvId = cid;

                if (data.event === "step_update" && data.step_update) {
                  const step = data.step_update;

                  if (step.step_type === "agent_response" && step.text_delta) {
                    const delta = step.text_delta;
                    (output.content[0] as any).text += delta;
                    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
                  } else if (step.step_type === "tool") {
                    const rawName = step.tool_name || step.tool_info?.name || "tool";
                    const stepId = step.step_index ?? rawName;

                    if (step.state === "ACTIVE") {
                      activeToolSteps.set(stepId, {
                        name: rawName,
                        params: step.tool_info?.parameters,
                        startTime: Date.now(),
                      });
                      const summary = formatToolCallSummary(rawName, step.tool_info?.parameters);
                      currentUi?.setWorkingMessage(`⚙️ ${summary}`);
                      currentUi?.setStatus("agy", `[agy] ${summary}`);
                    } else if (step.state === "DONE") {
                      const active = activeToolSteps.get(stepId);
                      activeToolSteps.delete(stepId);
                      currentUi?.setWorkingMessage(undefined);
                      currentUi?.setStatus("agy", "");

                      const duration = step.duration_seconds || (active ? (Date.now() - active.startTime) / 1000 : 0);
                      const params = step.tool_info?.parameters ?? active?.params;
                      const title = formatToolCardTitle(rawName, params);
                      const outText = extractToolOutputText(step.tool_info?.output || step.tool_info?.error);
                      const isErr = Boolean(step.tool_info?.error);

                      toolRunsCount++;
                      activeExtensionApi?.appendEntry<AgyToolCardData>("agy_tool", {
                        tool: rawName,
                        summary: title,
                        output: outText,
                        isError: isErr,
                        duration,
                      });
                    }
                  } else if (step.subagent_info) {
                    const sub = step.subagent_info;
                    const role = sub.role || sub.type_name || "subagent";
                    currentUi?.setWorkingMessage(`🤖 [subagent] ${role}`);
                    currentUi?.setStatus("agy", `[agy subagent] ${role}`);
                    toolRunsCount++;
                    activeExtensionApi?.appendEntry<AgyToolCardData>("agy_tool", {
                      tool: "subagent",
                      summary: `🤖 subagent [${role}] (${sub.type_name || "subagent"})`,
                      output: sub.log_uri ? `log: ${sub.log_uri}` : `id: ${sub.conversation_id}`,
                      isError: false,
                    });
                  }
                } else if (data.event === "result" && data.result) {
                  currentUi?.setWorkingMessage(undefined);
                  currentUi?.setStatus("agy", "");
                  const hasTurnResponse = Boolean(data.result.response || ((output.content[0] as any).text || "").trim());
                  if (hasTurnResponse || data.result.status === "SUCCESS") {
                    output.stopReason = "stop";
                    output.errorMessage = undefined;
                  } else {
                    output.stopReason = "error";
                    if (data.result.error && !output.errorMessage) {
                      output.errorMessage = data.result.error;
                    }
                  }
                  const u = data.result.usage;
                  if (u) {
                    output.usage = {
                      input: u.input_tokens || 0,
                      output: u.output_tokens || 0,
                      cacheRead: u.cache_read_tokens || 0,
                      cacheWrite: 0,
                      totalTokens: u.total_tokens || 0,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    };
                  }
                }
              } catch {}
            }

            clearTimeout(watchdog);
            currentUi?.setWorkingMessage(undefined);
            currentUi?.setStatus("agy", "");
            finish({ convId: seenConvId, stderr: capturedError, exitCode, timedOut, toolRunsCount });
          } catch (err) {
            clearTimeout(watchdog);
            currentUi?.setWorkingMessage(undefined);
            currentUi?.setStatus("agy", "");
            fail(err);
          }
        })();
      });

    try {
      stream.push({ type: "start", partial: output });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });

      let agyModel: string;
      try {
        agyModel = resolveModel(model.id, options?.reasoning);
      } catch (err: any) {
        output.stopReason = "error";
        output.errorMessage = err.message;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        return;
      }

      const sessionKey = resolveSessionKey(options);
      const isEphemeral = sessionKey.startsWith("ephemeral:");

      const isCompaction = Boolean(
        context.systemPrompt && (
          context.systemPrompt.includes("context summarization assistant") ||
          context.systemPrompt.includes("produce a structured summary") ||
          context.systemPrompt.includes("ONLY output the structured summary")
        )
      );

      const state = isEphemeral ? null : loadLinks();
      let link: SessionLink | undefined = state ? getLink(state, sessionKey) : undefined;
      const msgCount = (context.messages || []).length;

      // Auto-detect previous AGY conversation if not currently linked
      if (!link && !isEphemeral && !isCompaction) {
        const detectedId = detectConvIdFromSessionFile(activePiSessionKey || sessionKey);
        if (detectedId && conversationExists(detectedId)) {
          const sum = findAgyConversation(detectedId);
          link = {
            agyConvId: detectedId,
            syncedCount: msgCount,
            title: sum?.title,
            lastModel: agyModel,
            updatedAt: Date.now(),
          };
          saveLink(sessionKey, link);
        }
      }

      // If context was compacted or shortened in Pi, keep native AGY link alive
      if (link && msgCount < link.syncedCount) {
        link.syncedCount = msgCount;
        saveLink(sessionKey, link);
      }

      // Verify native conversation exists on disk
      if (link && !conversationExists(link.agyConvId)) {
        dropLink(sessionKey);
        link = undefined;
      }

      let promptToSend: string;
      let targetConvId: string | undefined;

      if (isCompaction) {
        // Standalone compaction prompt: don't pollute the native conversation's turn history
        const convContent = (context.messages || [])
          .map((m) => {
            const t = extractContentText(m.content);
            return isNoise(t) ? "" : formatMessage(m.role, t);
          })
          .filter(Boolean)
          .join("\n\n");
        promptToSend = `${context.systemPrompt}\n\n${convContent}`;
        targetConvId = undefined;
      } else if (link) {
        targetConvId = link.agyConvId;
        // Fast-forward syncedCount if gap is large to prevent flooding
        if (msgCount > link.syncedCount + 10) {
          link.syncedCount = msgCount - 1;
          saveLink(sessionKey, link);
        }

        const currentPrompt = extractCurrentPrompt(context);
        if (msgCount <= link.syncedCount + 1) {
          // Clean continuation: send only latest prompt
          promptToSend = currentPrompt;
        } else {
          // Intermediate external turns occurred in Pi while away
          const delta = buildDelta(context, link.syncedCount);
          promptToSend = delta
            ? [
                `[Recent Pi context before user prompt]`,
                delta,
                `[End recent context]`,
                currentPrompt,
              ].join("\n\n")
            : currentPrompt;
        }
      } else {
        // Fresh link: send full history if Pi session already has prior conversation
        targetConvId = undefined;
        promptToSend = buildFullHistory(context);
      }

      let result = await runTurn(promptToSend, agyModel, targetConvId);

      // Link-healing: if AGY conversation expired/not found, retry fresh
      if (!isCompaction && !result.convId && !((output.content[0] as any).text || "").trim() &&
          /convers|not found|invalid|expired/i.test(result.stderr || "")) {
        if (link) dropLink(sessionKey);
        link = undefined;
        promptToSend = buildFullHistory(context);
        result = await runTurn(promptToSend, agyModel, undefined);
      }

      if (options?.signal?.aborted || result.timedOut) {
        const reason = result.timedOut ? "Timed out" : "Aborted by user";
        output.stopReason = result.timedOut ? "error" : "aborted";
        output.errorMessage = reason;
        stream.push({ type: "error", reason: output.stopReason as any, error: output });
        stream.end();
        return;
      }

      let fullText = ((output.content[0] as any).text || "").trim();

      // If no text was produced and error is 503 / capacity on flash, attempt automatic fallback to pro
      if (!fullText && /503|UNAVAILABLE|capacity/i.test(result.stderr || output.errorMessage || "")) {
        if (agyModel.includes("flash")) {
          currentUi?.notify?.("Flash server capacity 503, retrying with Gemini 3.1 Pro...", "warning");
          result = await runTurn(promptToSend, "gemini-3.1-pro-high", targetConvId);
          fullText = ((output.content[0] as any).text || "").trim();
        }
      }

      if (!fullText && result.toolRunsCount > 0) {
        fullText = `*(${result.toolRunsCount} ferramentas executadas)*`;
        (output.content[0] as any).text = fullText;
        stream.push({ type: "text_delta", contentIndex: 0, delta: fullText, partial: output });
      }

      if (!fullText) {
        (output.content[0] as any).text = "";
        const detail = [
          `agy produced no output (exit ${result.exitCode}).`,
          result.stderr.trim() ? `[stderr]\n${result.stderr.trim()}` : "[stderr empty]",
        ].join("\n");
        logError("provider", `model=${agyModel} conv=${link?.agyConvId ?? "(fresh)"}\n${detail}`);
        output.stopReason = "error";
        output.errorMessage = detail;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        return;
      }

      // Persist link advance (count includes the assistant response produced this turn)
      const newConvId = result.convId ?? link?.agyConvId;
      if (!isEphemeral && !isCompaction && newConvId) {
        saveLink(sessionKey, {
          agyConvId: newConvId,
          syncedCount: msgCount + 1,
          lastModel: agyModel,
          updatedAt: Date.now(),
        });
      }

      stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial: output });
      output.stopReason = "stop";
      output.errorMessage = undefined;
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (err: any) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      logError("provider-exception", output.errorMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ─── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  activeExtensionApi = pi;

  // Official Pi TUI card renderer for Antigravity tool executions
  pi.registerEntryRenderer<AgyToolCardData>("agy_tool", (entry, { expanded }, theme) => {
    const data = entry.data ?? { tool: "tool", summary: "tool call" };
    const isError = Boolean(data.isError);
    const bgToken = isError ? "toolErrorBg" : "toolSuccessBg";
    const box = new Box(1, 1, (text: string) => theme.bg(bgToken, text));

    const title = data.summary || (data.tool === "bash" ? "$ bash" : data.tool);
    const styledTitle = theme.fg("toolTitle", theme.bold(title));
    const durStr = data.duration && data.duration > 0
      ? theme.fg("muted", ` (${data.duration.toFixed(1)}s)`)
      : "";

    box.addChild(new Text(styledTitle + durStr, 0, 0));

    const out = (data.output || "").trim();
    if (out) {
      const lines = out.split("\n");
      if (!expanded && lines.length > 5) {
        const previewLines = lines.slice(0, 5);
        const hidden = lines.length - 5;
        const styledOut = previewLines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
        const hint = theme.fg("muted", `\n... (${hidden} more lines, Ctrl+O to expand)`);
        box.addChild(new Text(`\n${styledOut}${hint}`, 0, 0));
      } else {
        const styledOut = lines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
        box.addChild(new Text(`\n${styledOut}`, 0, 0));
      }
    }

    return box;
  });

  const syncContext = (_event: any, ctx: any) => {
    updateSessionContext(ctx);
  };

  pi.on("session_start", syncContext);
  pi.on("session_switch", syncContext);
  pi.on("before_agent_start", syncContext);
  pi.on("agent_start", syncContext);
  pi.on("turn_start", syncContext);
  pi.on("before_provider_request", syncContext);
  pi.on("agent_end", () => {
    currentUi?.setWorkingMessage(undefined);
    currentUi?.setStatus("agy", "");
  });

  // ── 1. Provider ────────────────────────────────────────────────────────────
  pi.registerProvider("antigravity", {
    name: "Google Antigravity (agy)",
    baseUrl: "https://antigravity.google",
    apiKey: "agy-local-access",
    api: "antigravity-stream",
    models: ANTIGRAVITY_MODELS,
    streamSimple: streamAntigravity,
  });

  // ── 2. Tool (stateless one-shot delegation) ────────────────────────────────
  const AGY_TOOL_PARAMS = Type.Object({
    prompt: Type.String({
      description: "Self-contained task to delegate to Google Antigravity CLI (agy).",
    }),
    model: Type.Optional(
      Type.String({
        description: "Model ID (e.g. 'gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'). Defaults to gemini-3.1-pro-high.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for agy (defaults to current project directory)." }),
    ),
  });

  pi.registerTool({
    name: "agy",
    label: "Google Antigravity (agy)",
    description: "Delegates a complex coding, mathematical derivation, or deep analysis task to Google Antigravity CLI (agy) headlessly.",
    promptSnippet: "Delegate a task to Google Antigravity: agy(prompt, model?)",
    promptGuidelines: [
      "Use agy for deep reasoning (Gemini 3.1 Pro / Claude Sonnet) or when hitting API quota limits.",
      "Write a fully self-contained prompt — include all relevant context inline.",
      "Never call agy from within an antigravity-provider conversation.",
    ],
    parameters: AGY_TOOL_PARAMS,
    async execute(toolCallId, params, signal) {
      void toolCallId;
      let agyModel: string;
      try {
        agyModel = resolveModel(params.model || "gemini-3.1-pro-high");
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Unknown agy model: ${err.message}` }],
          isError: true,
          details: { model: params.model },
        };
      }
      const workDir = params.cwd || activePiSessionCwd || process.cwd();

      return new Promise<any>((resolvePromise) => {
        const proc = spawn(
          AGY_BIN,
          ["--dangerously-skip-permissions", "--model", agyModel, "--input-format", "stream-json", "--output-format", "stream-json"],
          { cwd: workDir, detached: true, stdio: ["pipe", "pipe", "pipe"] },
        );

        const pid = proc.pid;
        let stdoutText = "";
        let stderrText = "";
        let settled = false;
        let timedOut = false;

        const settle = (result: any) => {
          if (settled) return;
          settled = true;
          resolvePromise(result);
        };

        proc.stdin.on("error", () => {});

        if (proc.stdin.writable && !proc.killed) {
          try {
            proc.stdin.write(JSON.stringify({
              event: "user",
              message: { content: params.prompt },
            }) + "\n");
            proc.stdin.end();
          } catch {}
        }

        proc.stderr.on("data", (c) => { stderrText += c.toString(); });

        const watchdog = setTimeout(() => {
          timedOut = true;
          killGroup(pid, "SIGKILL");
        }, TOOL_TIMEOUT_MS);

        if (signal) {
          if (signal.aborted) {
            killGroup(pid, "SIGKILL");
          } else {
            signal.addEventListener("abort", () => killGroup(pid, "SIGKILL"), { once: true });
          }
        }

        const rl = readline.createInterface({ input: proc.stdout });
        (async () => {
          try {
            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                if (data.event === "step_update" && data.step_update?.step_type === "agent_response" && data.step_update.text_delta) {
                  stdoutText += data.step_update.text_delta;
                } else if (data.event === "result" && data.result?.response) {
                  if (!stdoutText) stdoutText = data.result.response;
                }
              } catch {}
            }
          } catch {}
        })();

        proc.on("error", (err) => {
          clearTimeout(watchdog);
          const transcript = `model=${agyModel} workDir=${workDir}\nspawn error: ${err.message || String(err)}`;
          logError("tool", transcript);
          settle({
            content: [{ type: "text", text: `Error spawning agy:\n${transcript}` }],
            isError: true,
            details: { model: agyModel, workDir },
          });
        });

        proc.on("close", (code) => {
          clearTimeout(watchdog);
          const out = stdoutText.trim();
          const errText = stderrText.trim();
          const header = timedOut
            ? `[agy timed out after ${Math.round(TOOL_TIMEOUT_MS / 1000)}s; process group killed]\n`
            : signal?.aborted
              ? `[agy aborted by user; process group killed]\n`
              : "";
          const text = (
            header +
            [out, errText ? `[stderr]\n${errText}` : ""].filter(Boolean).join("\n\n")
          ).trim() || "(No output from agy)";

          if (timedOut || signal?.aborted) {
            logError("tool", `model=${agyModel} exit=${code}\n${text}`);
          }

          settle({
            content: [{ type: "text", text }],
            isError: timedOut || !!signal?.aborted || code !== 0,
            details: { model: agyModel, workDir, exitCode: code ?? 0, timedOut },
          });
        });
      });
    },
  });

  // ── 3. Slash command (/agy <prompt>) ────────────────────────────────────────
  pi.registerCommand("agy", {
    description: "Run a one-shot query through Google Antigravity CLI",
    handler: async (args, ctx) => {
      updateSessionContext(ctx);
      const query = args?.trim();
      if (!query) {
        ctx.ui.notify("Usage: /agy <prompt>", "warning");
        return;
      }
      ctx.ui.setStatus("agy", "Antigravity running...");

      const state = loadLinks();
      const key = resolveSessionKey();
      const link = state.links[key];
      const convId = link?.agyConvId && conversationExists(link.agyConvId) ? link.agyConvId : undefined;

      const result = await new Promise<{ text: string; isError: boolean }>((resolvePromise) => {
        const cmdArgs = [
          "--dangerously-skip-permissions",
          "--model", "gemini-3.1-pro-high",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
        ];
        if (convId) cmdArgs.push("--conversation", convId);

        const proc = spawn(
          AGY_BIN,
          cmdArgs,
          { cwd: ctx.cwd || activePiSessionCwd || process.cwd(), detached: true, stdio: ["pipe", "pipe", "pipe"] },
        );

        const pid = proc.pid;
        let stdoutText = "";
        let stderrText = "";
        let settled = false;
        let timedOut = false;

        const settle = (val: { text: string; isError: boolean }) => {
          if (settled) return;
          settled = true;
          resolvePromise(val);
        };

        proc.stdin.on("error", () => {});

        if (proc.stdin.writable && !proc.killed) {
          try {
            proc.stdin.write(JSON.stringify({
              event: "user",
              message: { content: query },
            }) + "\n");
            proc.stdin.end();
          } catch {}
        }

        proc.stderr.on("data", (c) => { stderrText += c.toString(); });

        const watchdog = setTimeout(() => {
          timedOut = true;
          killGroup(pid, "SIGKILL");
        }, COMMAND_TIMEOUT_MS);

        const rl = readline.createInterface({ input: proc.stdout });
        (async () => {
          try {
            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                if (data.event === "step_update" && data.step_update?.step_type === "agent_response" && data.step_update.text_delta) {
                  stdoutText += data.step_update.text_delta;
                } else if (data.event === "result" && data.result?.response) {
                  if (!stdoutText) stdoutText = data.result.response;
                }
              } catch {}
            }
          } catch {}
        })();

        proc.on("error", (err) => {
          clearTimeout(watchdog);
          settle({ text: `spawn error: ${err.message}`, isError: true });
        });

        proc.on("close", (code) => {
          clearTimeout(watchdog);
          const out = stdoutText.trim();
          const errText = stderrText.trim();
          const header = timedOut ? `[timed out after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s]\n` : "";
          const text = (
            header +
            [out, errText ? `[stderr]\n${errText}` : ""].filter(Boolean).join("\n\n")
          ).trim() || "(No response from agy)";
          settle({ text, isError: timedOut || (code !== null && code !== 0) });
        });
      });

      ctx.ui.setStatus("agy", "");
      if (result.isError) {
        ctx.ui.notify(`agy error: ${result.text}`, "error");
      } else {
        pi.sendUserMessage(`[Antigravity response]:\n\n${result.text}`, { deliverAs: "followUp" });
      }
    },
  });

  // ── 4. Native AGY Session Manager (/agy-session) ─────────────────────────────
  pi.registerCommand("agy-session", {
    description: "Manage native Google Antigravity (AGY) session bridge & context reuse",
    handler: async (args, ctx) => {
      updateSessionContext(ctx);
      const key = resolveSessionKey();
      const rawArg = (args || "").trim();
      const [subcommand, ...rest] = rawArg.split(/\s+/);
      const target = rest.join(" ").trim();

      const state = loadLinks();
      const link = getLink(state, key);

      switch (subcommand?.toLowerCase()) {
        case "list": {
          const convs = getAgyConversations(15);
          if (convs.length === 0) {
            ctx.ui.notify("No AGY conversations found in ~/.gemini/antigravity-cli.", "info");
            return;
          }
          const lines = ["Recent Native Antigravity (AGY) Conversations:"];
          for (const c of convs) {
            const isCurr = link?.agyConvId === c.id;
            const marker = isCurr ? "★ [CURRENT] " : "  ";
            const shortId = c.id.slice(0, 8);
            const dateStr = c.modified ? c.modified.slice(0, 16).replace("T", " ") : "";
            lines.push(`${marker}${shortId} | ${c.title || "(Untitled)"} (${c.steps} steps, ${dateStr})`);
          }
          lines.push("\nCommands: /agy-session link <id> | /agy-session resume [id] | /agy-session import [id]");
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "link": {
          if (!target) {
            ctx.ui.notify("Usage: /agy-session link <conversation_id>", "warning");
            return;
          }
          const conv = findAgyConversation(target);
          if (!conv) {
            ctx.ui.notify(`AGY conversation "${target}" not found. Run \`/agy-session list\` to see available IDs.`, "error");
            return;
          }
          saveLink(key, {
            agyConvId: conv.id,
            syncedCount: (ctx.sessionManager?.getEntries?.() || []).length,
            title: conv.title,
            updatedAt: Date.now(),
          });
          if (conv.title && (ctx as any).setSessionName) {
            try { (ctx as any).setSessionName(conv.title); } catch {}
          }
          ctx.ui.notify(
            `Linked to native AGY conversation: "${conv.title}" (${conv.id.slice(0, 8)}).\n` +
            `Next turn in Pi will seamlessly resume this native conversation context.`,
            "info",
          );
          return;
        }

        case "resume": {
          let conv: AgyConversationSummary | undefined;
          if (target) {
            conv = findAgyConversation(target);
          } else {
            const convs = getAgyConversations(20);
            const cwd = ctx.cwd || process.cwd();
            const cwdUri = `file://${cwd}`;
            conv = convs.find((c) => c.workspaces && c.workspaces.includes(cwdUri)) ||
                   convs.find((c) => (c.workspaces || []).some((w) => cwdUri.startsWith(w) || w.startsWith(cwdUri))) ||
                   convs[0];
          }
          if (!conv) {
            ctx.ui.notify("No AGY conversation found to resume.", "warning");
            return;
          }
          saveLink(key, {
            agyConvId: conv.id,
            syncedCount: (ctx.sessionManager?.getEntries?.() || []).length,
            title: conv.title,
            updatedAt: Date.now(),
          });
          if (conv.title && (ctx as any).setSessionName) {
            try { (ctx as any).setSessionName(conv.title); } catch {}
          }
          ctx.ui.notify(
            `Resumed native AGY conversation: "${conv.title}" (${conv.id.slice(0, 8)}).\n` +
            `Native AGY context will be reused on subsequent turns.`,
            "info",
          );
          return;
        }

        case "import": {
          const query = target || link?.agyConvId;
          if (!query) {
            ctx.ui.notify("Usage: /agy-session import <conversation_id>", "warning");
            return;
          }
          const conv = findAgyConversation(query);
          if (!conv) {
            ctx.ui.notify(`Conversation "${query}" not found in AGY history.`, "error");
            return;
          }
          const turns = getAgyTranscript(conv.id);
          if (turns.length === 0) {
            ctx.ui.notify(`No transcript turns found for AGY conversation ${conv.id.slice(0, 8)}.`, "warning");
            return;
          }

          saveLink(key, {
            agyConvId: conv.id,
            syncedCount: turns.length,
            title: conv.title,
            updatedAt: Date.now(),
          });
          if (conv.title && (ctx as any).setSessionName) {
            try { (ctx as any).setSessionName(conv.title); } catch {}
          }

          ctx.ui.notify(
            `Imported & linked native AGY conversation "${conv.title}" (${turns.length} turns).\n` +
            `Transcript: ~/.gemini/antigravity-cli/brain/${conv.id.slice(0, 8)}.../transcript.jsonl\n` +
            `Native context active. Send your next message to continue in Pi.`,
            "info",
          );
          return;
        }

        case "reset": {
          dropLink(key);
          ctx.ui.notify("Antigravity session link reset. Next prompt will start a fresh AGY conversation.", "info");
          return;
        }

        case "open": {
          if (!link?.agyConvId) {
            ctx.ui.notify("Current Pi session is not linked to any AGY conversation.", "warning");
            return;
          }
          ctx.ui.notify(
            `To open directly in native AGY CLI:\n  agy --conversation ${link.agyConvId}`,
            "info",
          );
          return;
        }

        default: {
          const conv = link ? findAgyConversation(link.agyConvId) : undefined;
          const exists = link ? conversationExists(link.agyConvId) : false;
          const statusText = [
            `Pi Session: ${path.basename(key)}`,
            `AGY Conversation: ${link?.agyConvId ?? "(not linked)"}`,
            `Title: ${conv?.title ?? link?.title ?? "(none)"}`,
            `Native SQLite DB: ${link ? `${AGY_CONVERSATIONS_DIR}/${link.agyConvId}.db` : "(n/a)"} (${exists ? "active" : "missing"})`,
            `Native Brain Logs: ${link ? `${AGY_BRAIN_DIR}/${link.agyConvId}/...` : "(n/a)"}`,
            `Synced turns: ${link?.syncedCount ?? 0}`,
            `Last model: ${link?.lastModel ?? "(default)"}`,
            ``,
            `Commands:`,
            `  /agy-session list          List recent AGY conversations`,
            `  /agy-session link <id>     Link current Pi session to an AGY conversation`,
            `  /agy-session resume [id]   Resume AGY session for this workspace`,
            `  /agy-session import [id]   Import native transcript and link`,
            `  /agy-session reset         Unlink and start fresh on next turn`,
            `  /agy-session open          Show command to open in native agy CLI`,
          ].join("\n");
          ctx.ui.notify(statusText, "info");
          return;
        }
      }
    },
  });

  pi.on("session_start", (_event, _ctx) => {
    updateSessionContext(_ctx);
    const key = resolveSessionKey();
    const state = loadLinks();
    let link = getLink(state, key);
    if (!link && key && !key.startsWith("ephemeral:")) {
      const detectedId = detectConvIdFromSessionFile(key);
      if (detectedId && conversationExists(detectedId)) {
        const sum = findAgyConversation(detectedId);
        saveLink(key, {
          agyConvId: detectedId,
          syncedCount: (_ctx.sessionManager?.getEntries?.() || []).length,
          title: sum?.title,
          updatedAt: Date.now(),
        });
        _ctx.ui?.notify(`Antigravity: auto-linked to native AGY "${sum?.title || detectedId.slice(0, 8)}"`, "info");
        return;
      }
    }
    _ctx.ui.notify("Antigravity: provider + agy tool + /agy-session ready", "info");
  });
}
