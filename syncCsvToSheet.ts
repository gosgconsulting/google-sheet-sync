/**
 * Syncs specific-month data from a public CSV into Google Sheets.
 *
 * Behavior:
 * - Keeps historical rows
 * - Deletes rows from the target month
 * - Appends fresh rows from CSV (target month only)
 *
 * Designed for daily execution.
 */

import { google, sheets_v4 } from "googleapis";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

/**
 * Represents a single row from the CSV after parsing.
 * Adjust field names to match your CSV headers.
 */
export interface CsvRow {
  date: string;
  [key: string]: string;
}

/**
 * A Google Sheets row (17 columns).
 */
export type SheetRow = string[];

/**
 * Configuration required to run the sync.
 */
export interface SyncConfig {
  csvUrl: string;
  spreadsheetId: string;
  sheetName: string;
  dateColumnIndex: number; // 0-based index
  syncMonth?: string; // Format YYYY-MM. Defaults to current month if not provided.
}

/* -------------------------------------------------------------------------- */
/*                               Date Helpers                                  */
/* -------------------------------------------------------------------------- */

/**
 * Returns YYYY-MM string for comparison.
 */
function toYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Parses a CSV date safely.
 */
function parseDateSafe(value: string): Date | null {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/* -------------------------------------------------------------------------- */
/*                               CSV Handling                                  */
/* -------------------------------------------------------------------------- */

/**
 * Downloads and parses a public CSV file.
 */
async function fetchCsv(url: string): Promise<CsvRow[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV: ${res.statusText}`);
  }

  const text = await res.text();

  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];
}

/**
 * Filters CSV rows belonging to the target month.
 */
function filterCsvRowsByMonth(
  rows: CsvRow[],
  dateField: string,
  targetMonth: string
): SheetRow[] {
  const stripLeadingQuote = (s: string): string =>
    s.startsWith("'") ? s.slice(1) : s;

  return rows
    .map((row) => {
      const raw = stripLeadingQuote(
        (row[dateField] !== undefined ? row[dateField] : "") as string
      );
      const date = parseDateSafe(raw);
      if (!date) return null;

      if (toYearMonth(date) !== targetMonth) return null;

      return Object.values(row).map((v) =>
        typeof v === "string" ? stripLeadingQuote(v) : v
      );
    })
    .filter((r): r is SheetRow => Array.isArray(r));
}

/* -------------------------------------------------------------------------- */
/*                            Google Sheets API                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parses credentials from GOOGLE_APPLICATION_CREDENTIALS.
 * Supports either a file path (string) or inline JSON (object string).
 *
 * @returns Parsed credentials object, or undefined to use default (file path).
 */
function parseGoogleCredentials():
  | { client_email: string; private_key: string;[k: string]: unknown }
  | undefined {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.client_email && parsed.private_key) return parsed as { client_email: string; private_key: string;[k: string]: unknown };
    } catch {
      // Invalid JSON – fall back to default (treat as path, will likely fail)
    }
  }
  return undefined;
}

/**
 * Authenticates using Application Default Credentials.
 * GOOGLE_APPLICATION_CREDENTIALS can be:
 * - A file path to a service account JSON key
 * - Inline JSON string (the full service account object)
 */
function getSheetsClient(): sheets_v4.Sheets {
  const credentials = parseGoogleCredentials();
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    ...(credentials ? { credentials } : {}),
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Reads all sheet rows excluding headers.
 */
async function readSheetRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<SheetRow[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:Q`,
  });

  return (res.data.values ?? []) as SheetRow[];
}

/**
 * Deletes rows belonging to the target month.
 */
async function deleteRowsByMonth(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  rows: SheetRow[],
  dateColumnIndex: number,
  targetMonth: string
): Promise<void> {
  const rowIndexes = rows
    .map((row, index) => {
      const cell = row[dateColumnIndex];
      const date = parseDateSafe(cell !== undefined ? cell : "");
      if (!date) return null;
      return toYearMonth(date) === targetMonth ? index + 1 : null; // +1 for header offset
    })
    .filter((i): i is number => i !== null)
    .reverse();

  if (!rowIndexes.length) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: rowIndexes.map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      })),
    },
  });
}

/**
 * Appends rows in one batch operation.
 */
async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rows: SheetRow[]
): Promise<void> {
  if (!rows.length) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A2`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: rows,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                               Main Sync                                     */
/* -------------------------------------------------------------------------- */

/**
 * Entry point for syncing CSV → Google Sheets.
 */
export async function syncCsvToSheet(config: SyncConfig): Promise<void> {
  const sheets = getSheetsClient();
  const targetMonth = config.syncMonth || toYearMonth(new Date());

  const csvRows = await fetchCsv(config.csvUrl);
  const firstRow = csvRows[0];
  if (firstRow === undefined) {
    throw new Error("CSV has no rows");
  }
  const dateColumnKey = Object.keys(firstRow)[config.dateColumnIndex];
  if (dateColumnKey === undefined) {
    throw new Error(
      `Date column index ${config.dateColumnIndex} is out of range (CSV has ${Object.keys(firstRow).length} columns)`
    );
  }
  const monthRows = filterCsvRowsByMonth(csvRows, dateColumnKey, targetMonth);

  const sheetRows = await readSheetRows(
    sheets,
    config.spreadsheetId,
    config.sheetName
  );

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
  });

  const sheetId =
    meta.data.sheets?.find(
      (s) => s.properties?.title === config.sheetName
    )?.properties?.sheetId ?? 0;

  await deleteRowsByMonth(
    sheets,
    config.spreadsheetId,
    sheetId,
    sheetRows,
    config.dateColumnIndex,
    targetMonth
  );

  await appendRows(
    sheets,
    config.spreadsheetId,
    config.sheetName,
    monthRows
  );
}
