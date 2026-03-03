# google-sheet-sync

Syncs specific-date data from a public CSV into a Google Sheet. Keeps historical rows, replaces only the target date’s rows with fresh data from the CSV. Suited for daily or on-demand runs.

## Behavior

- Fetches and parses a CSV from a public URL
- Filters rows for a specific date (defaults to the last 7 days) by a configurable date column
- In the target sheet: deletes existing rows for the target date(s), then appends the filtered CSV rows
- Past dates in the sheet are left unchanged

## Requirements

- **Node.js** (v18+)
- **Google Sheets API access** via [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials):
  - Set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key JSON path, or
  - Use `gcloud auth application-default login` for local runs
- The service account (or user) must have edit access to the target spreadsheet

## Setup

```bash
npm install
npm run build
```

## Running

### HTTP server

Start the server (default port 3000, override with `PORT`):

```bash
npm start
```

**Endpoints**

| Method | Path    | Description |
|--------|---------|-------------|
| `POST` | `/sync` | Run sync. Body: JSON config (see below). |
| `GET`  | `/health` | Liveness check. |

**Sync config (POST body)**

| Field               | Type   | Description |
|---------------------|--------|-------------|
| `csvUrl`            | string | Public URL of the CSV. |
| `spreadsheetId`     | string | Google Sheet ID (from the sheet URL). |
| `sheetName`         | string | Exact name of the tab/sheet. |
| `dateColumnIndex`   | number | 0-based index of the date column in the CSV. |
| `syncDate`          | string | *(Optional)* Target date formatted as `YYYY-MM-DD`. Defaults to the last 7 days if omitted. |

Example:

```bash
curl -X POST http://localhost:3000/sync \
  -H "Content-Type: application/json" \
  -d '{
    "csvUrl": "https://example.com/data.csv",
    "spreadsheetId": "your-spreadsheet-id",
    "sheetName": "Sheet1",
    "dateColumnIndex": 0,
    "syncDate": "2024-05-15"
  }'
```

Success: `200` with `{ "ok": true }`. Errors: `4xx`/`5xx` with `{ "error": "message" }`.

### Programmatic use

```ts
import { syncCsvToSheet } from "./syncCsvToSheet";

await syncCsvToSheet({
  csvUrl: "https://example.com/data.csv",
  spreadsheetId: "your-spreadsheet-id",
  sheetName: "Sheet1",
  dateColumnIndex: 0,
  syncDate: "2024-05-15", // Optional
});
```

## CSV format

- First row: headers (column names).
- One column must hold dates (used for “current month” filtering); set its 0-based index in `dateColumnIndex`.
- Dates are parsed with `new Date(value)`; use a format JavaScript understands (e.g. ISO or locale-friendly).

## License

ISC
