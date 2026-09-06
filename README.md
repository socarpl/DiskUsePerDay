# DiskUsePerDay

A local web app that scans a folder tree and visualizes how much data was created each day —
drill down from **Year → Month → Day**, and list the actual files behind any period.

## Features

- Scans a folder recursively, recording each file's **size** and **creation date**.
- Drill-down bar chart: Years → Months (within a year) → Days (within a month).
- Summary cards: total size, total files, busiest period.
- Jump straight to a **year** via dropdown to list every file created that year.
- File list for any month or specific day — sorted largest → smallest, paginated
  (100 files per page), searchable, and sortable by column.
- Right-click a file to **open it** or **open its containing folder** in Explorer.
- Scan progress is tracked in the background and persists across page reloads.
- Multiple scanned folders are remembered; rescan or delete their data anytime.

## Requirements

- Python 3.9+
- Flask (see [requirements.txt](requirements.txt))

## Setup

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Run

```powershell
.venv\Scripts\python.exe app.py
```

Then open http://127.0.0.1:5000 in your browser and click **Scan Folder…**.

> The server binds to `127.0.0.1` only. It can open arbitrary local files/folders on request,
> so it must never be exposed beyond localhost.

## Project structure

```
app.py            Flask routes / API
scanner.py         Background folder scanner + SQLite storage
static/index.html  Page markup
static/app.js       Frontend logic (charts, drill-down, file table, context menu)
static/style.css   Styling
diskuse.db          SQLite database created on first scan (git-ignored)
```

## API overview

| Endpoint | Description |
|---|---|
| `POST /api/scan` | Start scanning a folder path |
| `GET /api/scan/status` | Poll progress of the current scan |
| `GET /api/roots` | List previously scanned folders |
| `DELETE /api/roots?root=` | Forget a scanned folder's data |
| `GET /api/years?root=` | Size/count per year |
| `GET /api/months?root=&year=` | Size/count per month |
| `GET /api/days?root=&year=&month=` | Size/count per day |
| `GET /api/files?root=&year=&month=&day=` | Paginated, sortable, searchable file list |
| `POST /api/open` | Open a scanned file or reveal its folder |

## Notes

- Scanned data (`diskuse.db`) is stored locally and git-ignored — it can contain real file
  paths and sizes from your machine, so don't commit it.
