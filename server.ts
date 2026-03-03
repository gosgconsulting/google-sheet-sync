/**
 * Load .env into process.env before any other imports.
 * Required so GOOGLE_APPLICATION_CREDENTIALS and PORT are available.
 */
import "dotenv/config";

/**
 * HTTP server that exposes the CSV → Google Sheets sync as an endpoint.
 *
 * @overview
 * This module starts a minimal HTTP server with two routes. No framework
 * dependencies; uses Node's built-in `http` module only.
 *
 * @routes
 * - POST /sync  – Runs the sync. Request body must be JSON matching {@link SyncConfig}.
 *   Success: 200 with `{ ok: true }`.
 *   Client error (bad JSON or missing/invalid fields): 400 with `{ error: string }`.
 *   Server error (sync threw): 500 with `{ error: string }`.
 * - GET /health – Liveness probe. Always returns 200 with `{ status: "ok" }`.
 *
 * @env
 * - PORT – Port to listen on (default: 3000).
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { syncCsvToSheet } from "./syncCsvToSheet";
import type { SyncConfig } from "./syncCsvToSheet";

/** Port to bind. Read from process.env.PORT, fallback 3000. */
const PORT = Number(process.env.PORT) || 3000;

/**
 * Reads the full request body as a UTF-8 string.
 *
 * @param req – Incoming HTTP request (stream).
 * @returns Promise that resolves with the raw body string, or rejects on stream error.
 */
function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Type guard: checks if a value is a valid SyncConfig (all required fields present and correctly typed).
 *
 * @param body – Parsed JSON value (typically from request body).
 * @returns true if body has required params + optional well-formed syncMonth.
 */
function isSyncConfig(body: unknown): body is SyncConfig {
  if (body === null || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;

  if (
    typeof o.csvUrl !== "string" ||
    typeof o.spreadsheetId !== "string" ||
    typeof o.sheetName !== "string" ||
    typeof o.dateColumnIndex !== "number"
  ) {
    return false;
  }

  if (o.syncMonth !== undefined) {
    if (typeof o.syncMonth !== "string" || !/^\d{4}-\d{2}$/.test(o.syncMonth)) {
      return false;
    }
  }

  return true;
}

/**
 * Sends a JSON response and ends the response.
 *
 * @param res – HTTP response object.
 * @param statusCode – HTTP status code (e.g. 200, 400, 500).
 * @param data – Object to serialize as JSON (sent as response body).
 */
function sendJson(res: ServerResponse, statusCode: number, data: object): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Handles POST /sync: parses JSON body, validates as SyncConfig, runs sync, returns 200 or error.
 *
 * - Non-POST: 405 Method not allowed.
 * - Invalid or empty JSON: 400 Invalid JSON body.
 * - Missing/invalid config fields: 400 with description of required fields.
 * - syncCsvToSheet throws: 500 with thrown message.
 *
 * @param req – Incoming request (must be POST for sync).
 * @param res – Response stream; always sent (JSON) by this function.
 */
async function handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body: unknown;
  try {
    const raw = await parseBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!isSyncConfig(body)) {
    sendJson(res, 400, {
      error:
        "Missing or invalid fields. Required: csvUrl (string), spreadsheetId (string), sheetName (string), dateColumnIndex (number). Optional: syncMonth (string, YYYY-MM).",
    });
    return;
  }

  try {
    await syncCsvToSheet(body);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
}

/**
 * Handles GET /health: liveness check for orchestration/load balancers.
 *
 * @param _req – Unused (request).
 * @param res – Response; sends 200 and `{ status: "ok" }`.
 */
function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: "ok" });
}

/**
 * Main request router: matches path (ignoring query string) and delegates to the right handler.
 *
 * - /sync   → handleSync
 * - /health → handleHealth
 * - else    → 404 Not found
 *
 * @param req – Incoming request.
 * @param res – Response; always sent by a handler.
 */
async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";
  const path = url.split("?")[0];

  if (path === "/sync") {
    await handleSync(req, res);
    return;
  }
  if (path === "/health") {
    handleHealth(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer(requestListener);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log("  POST /sync   – run sync (JSON body: csvUrl, spreadsheetId, sheetName, dateColumnIndex, [syncMonth])");
  console.log("  GET  /health – liveness");
});
