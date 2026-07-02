# The Devine Estimator

A browser-based estimating / takeoff tool for electrical, data and mechanical plans.
Upload a PDF or image, set the scale, drop standard symbols, draw cable runs on
coloured layers, link everything to your parts database, and get a costed takeoff
across every sheet in the project.

**Backend:** pure Python standard library (no pip installs).  
**Frontend:** HTML + Konva (canvas) + pdf.js, served by the backend.

---

## Requirements

- Python 3.8+ on the server (tested on 3.12). No third-party packages needed.
- A modern browser on the client (Chrome, Edge, Firefox, Safari).
- Internet access **from the browser** on first launch to load Konva + pdf.js from
  CDN. See [Offline Use](#offline-use) to remove that requirement.

---

## Installation

### 1. Clone / copy the files

```bash
git clone <repo-url> /opt/planapp
cd /opt/planapp
```

Or copy the project folder to wherever you want it to live (e.g. `/opt/planapp`).

### 2. Download vendor libraries (one-time, recommended)

Run this once on any machine with internet access to bundle the JS libraries locally
so the app works fully offline:

```bash
python3 fetch_vendor.py
```

### 3. Install as a systemd service

Create the service file:

```bash
sudo nano /etc/systemd/system/planapp.service
```

Paste the following (adjust `User`, `WorkingDirectory`, and `ExecStart` paths to
match where you installed the app):

```ini
[Unit]
Description=The Devine Estimator - Electrical Plan Estimating Tool
After=network.target

[Service]
Type=simple
User=jasond
WorkingDirectory=/opt/planapp
ExecStart=/usr/bin/python3 /opt/planapp/server.py --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable planapp      # start automatically on boot
sudo systemctl start planapp
```

---

## Starting and Stopping the Service

```bash
# Start
sudo systemctl start planapp

# Stop
sudo systemctl stop planapp

# Restart
sudo systemctl restart planapp

# Check status / recent logs
sudo systemctl status planapp
sudo journalctl -u planapp -f
```

To change the port, edit `ExecStart` in `/etc/systemd/system/planapp.service`
then run `sudo systemctl daemon-reload && sudo systemctl restart planapp`.

### Running manually (without systemd)

```bash
python3 server.py                        # default: 0.0.0.0:8000
python3 server.py --host 0.0.0.0 --port 8080

# Keep running after logout
nohup python3 server.py --port 8000 >estimator.log 2>&1 &
```

---

## Accessing the App

Open `http://<server-ip>:8000/` in a browser. On first run the server creates
`config.json` automatically, pointing at the bundled sample database.

---

## Features

### 1. Export Marked-Up Plans to PDF
Export any sheet with all symbols, lines, and layers rendered on top of the
background image as a PDF.

- Click the **PDF** button in the header.
- Choose what to include: background image, symbols, cable run lines.
- Click **Export** — the PDF downloads immediately.

### 2. Manual Takeoff Items
Add items that aren't drawn on the plan (supervision, testing, contingency, travel, etc.).

- Open the **Takeoff** tab on the right panel.
- Click **Add manual item**.
- Enter description, quantity, unit, cost price, retail price, and optional labour hours.
- Optionally search the parts database to auto-fill pricing from an existing part.
- The item appears in the takeoff and is included in all totals, CSV exports, and the
  printable quote.

### 3. Layers with Custom Names and Colours
Each layer represents a cable/run type. Layers have their own colour and can be
linked to a part in the database.

- **Add** a layer with the ＋ next to *Layers*.
- **Rename** by clicking the layer name.
- **Recolour** by clicking the colour swatch.
- **Show/hide** layers to declutter the canvas.
- **Link a part** by clicking the "link" text on the layer — this sets the cable part
  and a **labour hours per metre** rate for that layer. Both feed directly into the takeoff.

### 4. Symbol Placement with Custom Symbols
A built-in palette covers common electrical, data, and mechanical symbols. Add your own:

- Click **＋** next to *Symbols*.
- Enter a name, pick a category, and upload a PNG or SVG icon (or leave blank for
  an auto-generated labelled marker).
- Custom symbols are stored in the shared library on the server and are available
  across all projects. Symbols used in a project are also snapshotted inside the
  project file so they can be recovered if the library entry is later deleted.

### 5. Cable Drop per Symbol
Assign a **cable drop** (metres per device) to any symbol, linked to a cable layer.
The drop is automatically added to that layer's length in the takeoff.

- Right-click a symbol in the palette (or open **Symbol defaults** from the takeoff link)
  to set the drop length (m) and target layer.

### 6. Packaged Parts
Create multi-component assemblies (e.g. a switchboard package containing an enclosure,
RCDs, MCBs, terminals, and busbars) that act as a single selectable part.

- In the **Parts Library** tab, click **Create package**.
- Give the package a name and add components by searching the parts database — each
  component has its own quantity multiplier.
- The package appears in the parts search alongside normal parts and can be linked to
  any symbol or layer.
- In the takeoff the package shows as a single line item with its total price and
  labour hours. In the **printable quote** and **CSV export**, the package line shows
  the total cost while component sub-lines are listed beneath it showing their quantities
  with *Incl.* in the amount column — so there is no double-counting.
- Packages are saved to the shared parts database on the server, so they are available
  across all projects.

### 7. Labour Built into Layers (Labour per Metre)
Labour for cable installation is built directly into layers rather than being entered
manually each time.

- When linking a part to a layer, enter a **labour hours per metre** rate.
- The takeoff automatically multiplies that rate by the total measured length
  (lines + cable drops + wastage %) to produce labour hours and labour cost.
- The global labour rate ($/hr) at the top of the takeoff panel applies to all layers.
- Override the auto-calculated hours for any layer by typing in the **Hrs** cell in
  the takeoff — a ↺ reset button reverts to the calculated value.

### 8. Cable Routes Built by Packages (Conduit / Trunking / Cable Tray)
The **Cable Route** tool (`R` or the Route button in the toolbar) draws containment
runs — conduit, trunking, or cable tray — that are costed by counting sticks, corners,
and tees rather than by length alone.

- Draw a route on the canvas the same way as a line (click points, double-click to finish).
- Select the route and open **Properties** to set:
  - **Description** (label shown in the takeoff)
  - **Stick length** (default 4 m) — sets how many sticks are calculated from the measured run length
  - **Straight package** — the part or package used for each stick (e.g. a 4 m conduit package)
  - **Corner package** — applied once per detected or entered corner
  - **Tee package** — applied per manually entered tee count
  - **Corner count override** / **Tee count** — manual overrides when auto-detected counts are wrong
- Each slot (straight / corner / tee) can link to either a single part or a **package**,
  so a "conduit corner kit" package expands automatically into all its fittings.
- The **Routes & Conduit** section in the takeoff lists every route with its stick count,
  corner count, tee count, and the full BOM of parts below each.

### 9. Circuits Panel — Circuit Route Length and Voltage Drop
The **Circuits** panel (⚡ Circuits button in the header) lets you define electrical
circuits, assign drawn symbols to them, and automatically calculates electrical
compliance data per circuit.

**Setting up circuits:**

- Click **⚡ Circuits** to open the circuits drawer at the bottom of the screen.
- Add a circuit with the ＋ button. Each circuit has:
  - **Name** (e.g. "DB-A C1")
  - **CB rating** (e.g. "16A")
  - **Cable size** (e.g. "2.5" for 2.5 mm²)
  - **Cable cores** (e.g. "2C+E", "3C+E") — determines 1-phase or 3-phase calculations
  - **Cable type** (free text, e.g. "TPS", "V90")
- Assign a circuit to a symbol by selecting the symbol on the canvas and choosing its circuit
  in the Properties panel. Symbols on a circuit contribute their current draw (Table C9 load)
  to that circuit's load total.

**Calculated columns (live in the Circuits table):**

| Column | What it shows |
|--------|--------------|
| **Cable I** | Derated cable ampacity (A) per AS/NZS 3008.1.1 — click ⚙ to set installation conditions |
| **VD%** | Voltage drop percentage per AS/NZS 3008.1.1 Table 30, flagged red if > 5% (cl 3.5.1) |
| **Load** | Estimated circuit load (A) — sum of device contributions per AS/NZS 3000 Table C9 |
| **ELFI** | Earth fault loop impedance Zint (Ω) per AS/NZS 3000 Appendix B cl B5.2.2 |
| **Lmax** | Maximum one-way route length (m) per AS/NZS 3000 B5.2.2, Type C MCB |

**Circuit route length** is calculated automatically from the measured lengths of all
lines on layers linked to that circuit, plus the cable drops of all symbols assigned to it.

**Derating settings** (click ⚙ on any circuit row):

- Installation method: in insulation / clipped / conduit (air) / underground conduit / direct buried
- Insulation rating: V-75, V-90, XLPE 90°C, XLPE 110°C
- Cables bunched (grouping factor Cg per AS/NZS 3008.1.1 Table 25)
- Ambient / ground temperature (correction factor Ca)

All derating settings can be applied to a single circuit or to all circuits at once.

**Printable circuit schedule:** Click **Print schedule** in the Circuits panel to open a
formatted, print-ready circuit schedule showing all circuits with their CB rating, device
load, cable ampacity, installation method, cable size, cores, type, route length, voltage
drop, ELFI, and Lmax. Pass or fail is colour-coded (green / red) on every column.

### 10. ServiceM8 Integration
The app connects to [ServiceM8](https://www.servicem8.com) in two directions:

**Sync materials from ServiceM8 → parts database (Settings panel):**

- Enter your ServiceM8 API key in **Settings → ServiceM8 API key**.
- Click **Sync from ServiceM8** — the server fetches your full active materials list and
  upserts it into the local SQLite parts database (adds new items, updates prices on
  existing ones). A progress bar and summary (`added / updated / skipped / total`) are
  shown when complete.
- Requires a SQLite parts database (not CSV). The category for synced parts is set to
  `servicem8` so they can be filtered easily.

**Export takeoff → ServiceM8 Quote (Takeoff panel):**

- Click **Export to SM8** at the bottom of the Takeoff panel.
- The server creates a new **Quote** job in ServiceM8 and populates it with one material
  line per part number (quantities consolidated) plus a labour line for the total labour hours.
- On success a link to the created job UUID is shown as a toast notification.
- Requires the ServiceM8 API key to be set in Settings.

### 11. Export Takeoff as CSV
Click **Export CSV** in the takeoff panel to download all line items as a spreadsheet.

The CSV includes section (Device / Cable / Component / Manual), part number, description,
symbol name, quantity, unit cost, unit retail, material cost, material retail, labour hours,
labour rate, and labour total.

### 12. Printable Client Quote
Generate a clean, client-ready quote document:

- Click **Printable quote** in the takeoff panel.
- Enter your business details, client details, GST %, and choose cost or retail pricing.
- Opens in a new tab — print or save as PDF from the browser.

### 13. Consolidate Exports by Part Number
A checkbox in the Takeoff panel — **Consolidate same part no. / cable type in exports** —
merges rows that share the same part number and unit before exporting.

- When ticked, the CSV and printable quote each show **one line per part number** with
  quantities and costs summed across all symbol types or cable layers that use that part.
- Manual takeoff items with the same part number are also consolidated.
- The checkbox is per-session (unchecked by default on each page load); the live takeoff
  display on screen is unaffected.

### 14. Multi-Sheet Projects
A single project can hold many sheets (one per PDF page, or separate drawings).
Sheets share the same layer and symbol definitions; totals roll up across all sheets.

### 15. Text Annotations
Place free text directly on the plan canvas.

- Press `T` to enter text mode, then click a position on the plan and type.
- Click an existing text annotation in Select mode to edit it in-place.
- Text annotations are saved with the project and appear in PDF exports.

### 16. Measure Tool
Measure any distance on the plan without adding it to the takeoff.

- Press `M` to enter measure mode, then click two points — the real-world distance
  is shown immediately.
- Measurements are not saved; the tool is for spot-checking only.

### 17. Plan Image Opacity
Fade the background plan image to make symbols and lines easier to see.

- Use the **Opacity** slider in the left panel under the sheet name.
- Adjustable from 10% to 100%. Saved per sheet.

### 18. Undo / Redo
Full undo/redo history (up to 50 snapshots) covering all canvas and layer changes.

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` | Save project |

Undo / Redo buttons are also in the header toolbar.

### 19. Marquee / Multi-Select
Select multiple symbols at once by clicking and dragging a selection box on the canvas.

- A banner shows how many symbols are selected.
- Move all selected symbols together by dragging.
- Reassign all selected symbols to a different layer via the dropdown in the selection banner.

### 20. Reference Number Labels on Symbols
Each placed symbol instance can carry a reference number (e.g. `GPO-01`) shown as a
label beneath the icon on the canvas.

- Edit the **Ref No.** field in the Properties panel for any selected symbol.
- The global **Ref label style** setting in Settings controls the label size (10–200%)
  and colour across all symbols in the project.

### 21. Per-Instance Part Override
By default a symbol uses the part linked to its type in the palette. You can override
this for any individual placed instance:

- Select the symbol on the canvas.
- In the **Properties** panel, use the **Part override** field to search and assign a
  different part just for that instance.
- The override appears in the takeoff; all other instances of the same symbol type
  are unaffected.

### 22. Symbol Filter by Layer
The symbol palette can be filtered to show only symbols assigned to the active layer.

- Use the **Filter by layer** dropdown above the symbol palette.
- Useful on large projects with many symbol types spread across multiple cable types.

### 23. Draw Custom Symbols In-App
Build vector symbol graphics directly in the browser without external tools.

- Click **＋** next to *Symbols* and choose the **Draw** tab.
- Draw shapes on the canvas: rectangle, ellipse, line, text.
- Set stroke colour, fill colour (or transparent fill), stroke width, and font size.
- Shapes can carry real-world dimensions (in mm) so the symbol auto-sizes on calibrated plans.
- Categories available: Electrical, Data / Comms, HVAC, Mechanical, Custom.
- Click **Save** to add the drawn symbol to the palette. It is stored server-side in the
  shared symbol library so it is available across all projects.

### 24. Import Symbols from DXF
Import symbols directly from DXF/DWG CAD files — no conversion to PNG/SVG needed.

- Click **＋** next to *Symbols*, choose **Import DXF**, and upload a `.dxf` file.
- The server parses CAD entities (LINE, ARC, CIRCLE, LWPOLYLINE, TEXT, MTEXT) and
  generates an SVG icon automatically. Text labels in the DXF are extracted as the
  symbol name.
- The resulting symbol behaves identically to any other custom symbol.

### 25. Missing Symbols Restore
When a project references a symbol type that is no longer in the library (e.g. after
loading a project on a different machine), the app offers to restore it:

- A **Restore symbols** dialog lists every missing type.
- **Save to library** — adds the symbol definition back to the shared library so all
  future projects can use it.
- **This project only** — restores it for the current session without touching the library.

### 26. Parts Database Editor
Edit parts directly inside the app without touching the database file externally.

- Open the **Parts Library** tab and click the **Edit DB** button.
- A searchable table shows all parts with their part number, description, cost, retail,
  category, and unit.
- **Add**, **Edit**, or **Delete** individual rows. Changes are written immediately to
  the SQLite database on the server.

### 27. Import Parts from CSV
Bulk-load parts from a CSV file into the database without using ServiceM8.

- In the **Parts Library** tab, click **Import CSV**.
- Upload a `.csv` file. Required columns: `Item Number`, `Name`, `Purchase Cost`, `Price`
  (common aliases are detected automatically).
- New parts are inserted; existing part numbers have their cost and retail updated.
- A progress bar and summary (`added / updated / skipped`) are shown on completion.
- Requires a SQLite parts database (not a CSV database path).

### 28. Custom Parts (per project)
Add parts that aren't in your database directly to the current project:

- In the **Parts Library** tab, click **＋ Add custom part**.
- Custom parts are stored inside the project JSON, appear in searches alongside
  database parts, and can be linked like any other part — even when no database is configured.

### 29. Project and Database Backup / Restore
Back up and restore the parts database and all saved projects from within the app.

- Open **Settings** and scroll to the **Backup & Restore** section.
- **Download database** — downloads the SQLite parts database file (`.db`).
- **Download projects** — downloads a ZIP containing all project JSON files (including
  any folder structure) and custom symbol definitions.
- **Restore database** — upload a `.db` file to replace the current parts database.
- **Restore projects** — upload a projects ZIP to restore saved projects (folder paths
  are preserved).

### 30. Project Folders
Projects can be organised into folders and sub-folders. The folder structure is
stored as real sub-directories inside the `projects/` folder on the server.

**Saving into a folder:**

- Click **Save** — a dialog opens with two fields: **Project name** and **Folder**.
- The Folder field auto-completes from existing folder names (click to pick, or type a new one).
- Use `/` in the folder field for nested folders, e.g. `Client A/2024`.
- A preview line at the bottom shows the full path before you confirm.

**Opening and navigating:**

- Click **Open** to see a collapsible folder tree. Click a folder header (📁) to
  expand or collapse it.
- Each project row has a **✎** (move/rename) button — enter a new path (e.g.
  `Client B/Job 3`) to move the project to a different folder instantly.
- Deleting the last project in a folder automatically removes the empty folder.

### 31. Offline / Vendor-Bundled JS Libraries
After running `python3 fetch_vendor.py` once, all JavaScript (Konva, pdf.js) is
served locally — the app works with no internet connection at all.

```bash
python3 fetch_vendor.py
```

This downloads `konva.min.js`, `pdf.min.js`, and `pdf.worker.min.js` into
`static/vendor/`. The app automatically prefers those local copies going forward.

---

## Using the App

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `V` | Select mode |
| `C` | Calibrate scale |
| `S` | Symbol placement mode |
| `L` | Circuit (cable run) drawing mode |
| `R` | Cable route drawing mode |
| `T` | Text annotation mode |
| `M` | Measure tool (not saved) |
| `Enter` | Finish drawing a line or route |
| `Esc` | Cancel / deselect |
| `Delete` | Remove selected item |
| `Space` (hold) | Pan the canvas |
| Scroll | Zoom in / out |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` | Save project |

### Typical workflow

1. **Add a sheet** – click ＋ next to *Sheets*, or drop a PDF/image on the canvas.
   Multi-page PDFs import as one sheet per page.
2. **Set scale** (`C`) – click two known points, type the real distance.
3. **Place symbols** (`S`) – pick from the palette, click on the plan. Drag to
   reposition in Select mode; use corner handles to resize or rotate.
4. **Draw cable runs** (`L`) – select a layer, click to add points, double-click or
   `Enter` to finish. The scaled length is printed on the line.
5. **Draw containment routes** – use the **Cable Route** tool in the toolbar to draw
   conduit/trunking/tray runs. Select the route and open Properties to assign straight,
   corner, and tee packages so the takeoff prices them by stick count automatically.
6. **Link parts to layers** – click a layer's link text to set the cable part and
   labour hours per metre rate.
7. **Assign circuits** – open **⚡ Circuits**, create your circuits (CB rating, cable
   size, cores), then assign symbols to circuits via the Properties panel. Voltage drop,
   ELFI, Lmax, and cable ampacity calculate automatically from the measured route length.
8. **Review the takeoff** – check counts and lengths in the right panel, adjust
   wastage % and labour rate, add manual items if needed. Tick **Consolidate** to
   merge same part numbers before exporting.
9. **Export** – download CSV, generate a printable quote, export a marked-up PDF, or
   push the quote directly to ServiceM8 with **Export to SM8**.
10. **Save** – click **Save**, choose or type a folder, confirm the name, and save.
    Use **Open** to browse the folder tree and load a previous project.

---

## Parts Database

Open **Settings** (⚙) in the app and configure:

- **Database path** – absolute path on the server to a SQLite file (`.db` / `.sqlite`)
  **or** a `.csv` file.
- **Table name** – for SQLite (ignored for CSV; CSV becomes a table called `parts`).
- **Column mapping** – map your columns to: part number, description, cost price,
  retail price, and optional unit + category.

Click **Save & test** — green tick means it's working; errors show the mismatched column.

A sample database with 35 electrical/data/mechanical parts is at `data/parts.db`.
Regenerate or inspect its schema:

```bash
python3 make_sample_db.py
```

Default columns: `part_no, description, category, unit, cost, retail`.

---

## Offline Use

If the browser can't reach the CDN, buttons won't respond (Settings won't open,
uploads do nothing). Fix it once:

```bash
python3 fetch_vendor.py     # on any machine with internet
```

This downloads `konva.min.js`, `pdf.min.js`, and `pdf.worker.min.js` into
`static/vendor/`. The app automatically prefers those local copies going forward.

---

## Data Storage

| Data | Location |
|------|----------|
| Parts | Your external SQLite/CSV file (configured in Settings) |
| Custom packages | `packages` table inside the parts SQLite database |
| Custom symbols | `symbols` table inside the parts SQLite database |
| Projects | `projects/<folder>/<name>.json` — folder is optional; flat projects sit directly in `projects/` |
| Settings | `config.json` next to `server.py` |
| Last-open project | `session.json` (survives browser refresh) |

---

## Project Structure

```
planapp/
├── server.py            # zero-dependency HTTP backend + API
├── fetch_vendor.py      # downloads JS libraries for offline use
├── make_sample_db.py    # builds data/parts.db (documents default schema)
├── data/parts.db        # sample parts database (35 parts)
├── projects/            # saved projects
│   ├── Untitled.json    # flat project (no folder)
│   └── Client A/        # optional sub-folder
│       └── Job 1.json
├── static/
│   ├── index.html       # entire frontend
│   ├── css/styles.css
│   ├── js/app.js
│   └── vendor/          # local JS libraries (after running fetch_vendor.py)
└── README.md
```

---

## Notes

- No authentication, by design — run behind a firewall or VPN if needed.
- Plans are rasterised on upload (PDFs capped near 2000 px on the long edge).
  Switching a sheet's page clears that sheet's markups.
- Concurrent edits to the same project use last-write-wins.
- Line editing is add/delete only (move whole line, or delete and redraw);
  per-vertex editing is not supported.
