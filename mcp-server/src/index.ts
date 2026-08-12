#!/usr/bin/env node
/**
 * CRMF Central MCP Server (READ-ONLY).
 *
 * Exposes the central fleet-monitoring facility to AI systems via MCP: fleet
 * status, per-rig drill-down, fleet-wide alarms, data quality, governance
 * rollout, workover performance, wells, maintenance and reports. Read-only:
 * the server mints a `viewer`-role JWT (signed with the central JWT secret),
 * so the backend RBAC rejects any write. Streamable HTTP transport at /mcp.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { z } from "zod";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";

// --- Config ----------------------------------------------------------------
const BACKEND_URL = process.env.BACKEND_URL || "http://crmf-backend:6000";
const PORT = parseInt(process.env.PORT || "3000", 10);
const JWT_SECRET = process.env.JWT_SECRET || "";
const MCP_API_KEY = process.env.MCP_API_KEY || "";
// REQUIRED: an unset key used to mean an OPEN endpoint (mitigated only by the
// loopback bind) — one MCP_*_BIND=0.0.0.0 away from an unauthenticated read
// API on the LAN. Fail fast instead.
if (!MCP_API_KEY || MCP_API_KEY.length < 16) {
  console.error("FATAL: MCP_API_KEY env var is required (>=16 chars) — it is the bearer key MCP clients present.");
  process.exit(1);
}
const CHARACTER_LIMIT = 25000;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error("FATAL: JWT_SECRET env var is required (>=16 chars) to mint the read-only central token.");
  process.exit(1);
}

// --- Auth: mint + cache a viewer JWT (read-only by construction) -----------
let cached: { token: string; exp: number } | null = null;
function viewerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  // Central token payload IS the user object: { username, display, role, source }.
  const token = jwt.sign({ username: "mcp-readonly", display: "MCP Read-Only", role: "viewer", source: "local" }, JWT_SECRET, { expiresIn: "1h" });
  cached = { token, exp: now + 3600 };
  return token;
}

async function apiGet<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await axios.get<T>(`${BACKEND_URL}${path}`, {
    params,
    timeout: 30000,
    headers: { Authorization: `Bearer ${viewerToken()}`, Accept: "application/json" },
  });
  return res.data;
}

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      switch (error.response.status) {
        case 401: return "Error: central backend rejected the read-only token (check JWT_SECRET matches the central backend).";
        case 403: return "Error: permission denied (this MCP server is read-only).";
        case 404: return "Error: resource not found. Check the rig id / parameters.";
        default: return `Error: central request failed with status ${error.response.status}.`;
      }
    }
    if (error.code === "ECONNABORTED") return "Error: request to the central backend timed out.";
    if (error.code === "ECONNREFUSED") return `Error: cannot reach the central backend at ${BACKEND_URL}.`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function jsonResult(obj: unknown) {
  let text = JSON.stringify(obj, null, 2);
  let structured: unknown = obj;
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… [truncated at ${CHARACTER_LIMIT} chars — narrow the query]`;
    structured = { truncated: true, note: "Response truncated; narrow your query (fewer metrics / shorter window / a specific rig).", preview: obj };
  }
  return { content: [{ type: "text" as const, text }], structuredContent: structured as Record<string, unknown> };
}
function errResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// --- Server + tools --------------------------------------------------------
const server = new McpServer({ name: "ahwr-central-mcp-server", version: "1.0.0" });

server.registerTool("central_get_fleet", {
  title: "Get fleet status",
  description:
    "Return all rigs in the fleet with live status (online/degraded/stale/offline/pending), health score (0-100), " +
    "active job/activity, alarm counts by priority, and sync lag. Read-only. Use for 'how is the whole fleet doing'.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/fleet")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_fleet_summary", {
  title: "Get fleet KPI summary",
  description: "Return fleet-wide KPI aggregates: rig counts by status, average health, total alarms by priority. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/fleet/summary")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig", {
  title: "Get a single rig's detail",
  description: "Return one rig's metadata + rolled-up live status (health, alarms, active job, last-data time). Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3' (discover ids via central_get_fleet).") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_live", {
  title: "Get a rig's live telemetry mirror",
  description: "Return the latest telemetry snapshot mirrored from a rig (same shape as the edge HMI). Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'.") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/live`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_history", {
  title: "Get a rig's historical telemetry",
  description:
    "Return multi-metric time-series history for a rig. Provide `metrics` as comma-separated dataKeys " +
    "(e.g. 'drilling.rop,drawworks.hook_load') and `minutes` of trailing window. Read-only.",
  inputSchema: {
    rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'."),
    metrics: z.string().min(1).describe("Comma-separated dataKeys, e.g. 'drilling.rop,mudpump.pressure'."),
    minutes: z.number().int().min(1).max(10080).default(60).describe("Trailing window in minutes (default 60, max 10080 = 7d)."),
  },
  annotations: RO,
}, async ({ rigId, metrics, minutes }) => {
  try {
    const rows = await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/history-multi`, { metrics, minutes });
    return jsonResult({ rigId, metrics: metrics.split(",").map((m) => m.trim()), minutes, rows });
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_alarms", {
  title: "Get a rig's alarm history",
  description: "Return alarm events and state transitions for a specific rig. Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'.") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/alarms`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_activity", {
  title: "Get a rig's activity timeline",
  description: "Return the workover activity timeline for a rig (phase segments, productive vs NPT). Read-only.",
  inputSchema: {
    rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'."),
    hours: z.number().int().min(1).max(168).default(24).describe("Trailing window in hours (default 24)."),
  },
  annotations: RO,
}, async ({ rigId, hours }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/activity`, { hours })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_alarms", {
  title: "Get fleet-wide active alarms",
  description: "Return active alarms across the whole fleet, optionally filtered by priority. Read-only.",
  inputSchema: { priority: z.enum(["P1", "P2", "P3"]).optional().describe("Filter to a single priority (P1/P2/P3).") },
  annotations: RO,
}, async ({ priority }) => {
  try { return jsonResult(await apiGet("/api/alarms", priority ? { priority } : undefined)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_data_quality", {
  title: "Get fleet data-quality",
  description: "Return per-rig data-quality: health scores, metric completeness, and freshness/staleness. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/data-quality")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_governance", {
  title: "Get rollout governance",
  description: "Return the stage-gate rollout funnel (per-rig gate/commissioning/adoption), open escalations, and decisions. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/governance")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_workover", {
  title: "Get fleet workover performance",
  description: "Return cross-fleet workover analytics over a trailing window: ROP, WOB, connection quality, efficiency, NPT. Read-only.",
  inputSchema: { hours: z.number().int().min(1).max(720).default(24).describe("Trailing window in hours (default 24).") },
  annotations: RO,
}, async ({ hours }) => {
  try { return jsonResult(await apiGet("/api/workover", { hours })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_wells", {
  title: "List fleet wells",
  description: "Return wells across the fleet (status, asset unit, field), optionally filtered. Read-only.",
  inputSchema: {
    query: z.string().max(80).optional().describe("Free-text search (well name/field)."),
    status: z.string().max(40).optional().describe("Filter by status (e.g. active, completed, planned)."),
    assetUnit: z.string().max(80).optional().describe("Filter by asset unit."),
  },
  annotations: RO,
}, async ({ query, status, assetUnit }) => {
  try {
    const params: Record<string, unknown> = {};
    if (query) params.q = query;
    if (status) params.status = status;
    if (assetUnit) params.assetUnit = assetUnit;
    return jsonResult(await apiGet("/api/wells", params));
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_maintenance_summary", {
  title: "Get fleet maintenance summary",
  description: "Return PM compliance %, overdue counts, and breakdown counts per rig + fleet aggregate. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/maintenance/summary")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_fleet_report", {
  title: "Get fleet operations report",
  description: "Return a period-aware fleet operations report (KPIs aggregated). Read-only.",
  inputSchema: { period: z.enum(["snapshot", "daily", "weekly", "monthly"]).default("snapshot").describe("Report period (default snapshot).") },
  annotations: RO,
}, async ({ period }) => {
  try { return jsonResult(await apiGet("/api/reports/fleet", { period })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_list_tags", {
  title: "List the standard tag dictionary",
  description: "Return the canonical telemetry tag dictionary the central expects (metric, unit, group). Read-only — use to learn valid dataKeys for central_get_rig_history.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/config/tags")); } catch (e) { return errResult(handleApiError(e)); }
});

// --- Streamable HTTP transport (stateless JSON) ----------------------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "ahwr-central-mcp-server", backend: BACKEND_URL, tls: !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) });
});

function authorized(req: Request): boolean {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return false;
  // Length-independent constant-time comparison: hash both sides first so
  // neither length nor prefix leaks through response timing.
  const got = crypto.createHash("sha256").update(h).digest();
  const want = crypto.createHash("sha256").update(`Bearer ${MCP_API_KEY}`).digest();
  return crypto.timingSafeEqual(got, want);
}

// Audit log every MCP request (who/when/what) — attribution for read access.
function auditLog(req: Request, ok: boolean) {
  const body = (req.body || {}) as { method?: string; params?: { name?: string } };
  console.error(JSON.stringify({
    ts: new Date().toISOString(), evt: "mcp", server: "central",
    ip: req.ip, method: body.method || null, tool: body.params?.name || null, authorized: ok,
  }));
}

app.post("/mcp", async (req: Request, res: Response) => {
  const ok = authorized(req);
  auditLog(req, ok);
  if (!ok) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// Serve HTTPS when a cert+key are provided (required for Cowork / claude.ai
// remote connectors); otherwise fall back to HTTP for trusted loopback dev.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;
if (TLS_CERT_FILE && TLS_KEY_FILE) {
  const creds = { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) };
  https.createServer(creds, app).listen(PORT, () => {
    console.error(`ahwr-central-mcp-server (read-only, TLS${MCP_API_KEY ? "+auth" : ""}) on https://0.0.0.0:${PORT}/mcp  → central ${BACKEND_URL}`);
  });
} else {
  app.listen(PORT, () => {
    console.error(`ahwr-central-mcp-server (read-only, HTTP${MCP_API_KEY ? "+auth" : ""}) on http://0.0.0.0:${PORT}/mcp  → central ${BACKEND_URL}`);
  });
}
