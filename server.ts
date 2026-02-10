/**
 * HTTP server that exposes the CSV → Google Sheets sync as an endpoint.
 *
 * POST /sync  – body: JSON SyncConfig (csvUrl, spreadsheetId, sheetName, dateColumnIndex)
 * GET  /health – liveness check
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { syncCsvToSheet } from "./syncCsvToSheet";
import type { SyncConfig } from "./syncCsvToSheet";

const PORT = Number(process.env.PORT) || 3000;

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isSyncConfig(body: unknown): body is SyncConfig {
  if (body === null || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  return (
    typeof o.csvUrl === "string" &&
    typeof o.spreadsheetId === "string" &&
    typeof o.sheetName === "string" &&
    typeof o.dateColumnIndex === "number"
  );
}

function sendJson(res: ServerResponse, statusCode: number, data: object): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

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
        "Missing or invalid fields. Required: csvUrl (string), spreadsheetId (string), sheetName (string), dateColumnIndex (number)",
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

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: "ok" });
}

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
  console.log("  POST /sync   – run sync (JSON body: csvUrl, spreadsheetId, sheetName, dateColumnIndex)");
  console.log("  GET  /health – liveness");
});
