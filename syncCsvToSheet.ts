/**
 * Syncs current-month data from a public CSV into Google Sheets.
 *
 * Behavior:
 * - Keeps historical rows
 * - Deletes rows from the current month
 * - Appends fresh rows from CSV (current month only)
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
 * Filters CSV rows belonging to the current month.
 */
function filterCurrentMonthCsvRows(
  rows: CsvRow[],
  dateField: string
): SheetRow[] {
  const nowYM = toYearMonth(new Date());

  return rows
    .map((row) => {
      const raw = row[dateField];
      const date = parseDateSafe(raw !== undefined ? raw : "");
      if (!date) return null;

      if (toYearMonth(date) !== nowYM) return null;

      return Object.values(row);
    })
    .filter((r): r is SheetRow => Array.isArray(r));
}

/* -------------------------------------------------------------------------- */
/*                            Google Sheets API                                 */
/* -------------------------------------------------------------------------- */

/**
 * Authenticates using Application Default Credentials.
 */
function getSheetsClient(): sheets_v4.Sheets {
  return google.sheets({
    version: "v4",
    auth: new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    }),
  });
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
 * Deletes rows belonging to the current month.
 */
async function deleteCurrentMonthRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  rows: SheetRow[],
  dateColumnIndex: number
): Promise<void> {
  const nowYM = toYearMonth(new Date());

  const rowIndexes = rows
    .map((row, index) => {
      const cell = row[dateColumnIndex];
      const date = parseDateSafe(cell !== undefined ? cell : "");
      if (!date) return null;
      return toYearMonth(date) === nowYM ? index + 1 : null; // +1 for header offset
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
    valueInputOption: "RAW",
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
  const monthRows = filterCurrentMonthCsvRows(csvRows, dateColumnKey);

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

  await deleteCurrentMonthRows(
    sheets,
    config.spreadsheetId,
    sheetId,
    sheetRows,
    config.dateColumnIndex
  );

  await appendRows(
    sheets,
    config.spreadsheetId,
    config.sheetName,
    monthRows
  );
}
