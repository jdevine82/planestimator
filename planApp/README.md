# Plan Estimator

A browser-based estimating / takeoff tool for electrical, data and mechanical plans.
Upload a PDF or image, set the scale, drop standard symbols, draw cable runs on
coloured layers, link everything to your parts database, and get a costed takeoff
across every sheet in the project.

Backend = pure Python standard library (no pip installs).
Frontend = HTML + Konva (canvas) + pdf.js, served by the backend.

---

## 1. Requirements

- Python 3.8+ on the Linux server (tested on 3.12). Nothing else to install.
- A modern browser on the client (Chrome, Edge, Firefox, Safari).
- Internet access **from the browser** the first time, to load Konva + pdf.js from
  a CDN. See "Running fully offline" below to remove that requirement.

## 2. Run it

```bash
cd plan-estimator
python3 server.py                 # serves on 0.0.0.0:8000
# or choose host/port:
python3 server.py --host 0.0.0.0 --port 8080
```

Then open `http://<server-ip>:8000/` in a browser. On first run the server creates
`config.json` automatically, pointing at the bundled sample database.

To keep it running after you log out:

```bash
nohup python3 server.py --port 8000 >estimator.log 2>&1 &
```

### Optional: run inside a virtualenv

The app needs no third-party packages, so a venv is optional — but it works fine
and pins the Python you use. There is no `requirements.txt` to install.

```bash
cd plan-estimator
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python server.py
deactivate                       # when finished
```

## 3. Your parts database

Open **⚙ Settings** in the app. Set:

- **Database path** – an absolute path *on the server* to either a SQLite file
  (`.db` / `.sqlite`) **or** a `.csv` file.
- **Table name** – for SQLite (ignored for CSV; CSV becomes a table called `parts`).
- **Column mapping** – tell the app which of your columns are the part number,
  description, cost price, retail price, and (optional) unit + category.

Click **Save & test** – you'll get a green tick if it can read the parts, or a clear
message telling you which column name didn't match.

A working sample lives at `data/parts.db` (35 electrical/data/mechanical parts).
Re-generate or inspect its schema with:

```bash
python3 make_sample_db.py
```

Expected default columns: `part_no, description, category, unit, cost, retail`.

## 4. Using the app

1. **Add a sheet** – click ＋ next to *Sheets*, or drop a PDF/image on the canvas.
   Multi-page PDFs can be imported as one sheet per page.
2. **Set scale** (C) – click two points across a known dimension on the plan, then
   type its real length. Each sheet has its own scale. Drag the amber end-handles to
   fine-tune; double-click a handle to re-enter the length.
3. **Place symbols** (S) – pick a symbol from the palette, click on the plan. In
   Select mode, drag to reposition, and use the corner handles to resize / rotate a
   selected symbol. The **New symbol size** slider sets the size for symbols you place
   next. Add your own symbols with the ＋ next to *Symbols* (upload a PNG/SVG icon, or
   leave blank for an auto-generated labelled marker). Custom symbols save with the
   project; shift-click one in the palette to delete it.
4. **Draw runs** (L) – pick/active a layer, click to add points, double-click or Enter
   to finish. The scaled length prints on the line.
5. **Layers** – each layer is a cable/run type with its own colour and linked part.
   Add (＋), rename, recolour (click the swatch), show/hide, or delete.
6. **Link parts** – click a layer's "link" text, or right-click a palette symbol, or
   use the "link part" links in the Takeoff. For symbols you can also set a **cable
   drop** (metres added per device to a chosen cable layer). Need a part that isn't in
   your database? Use **＋ Add custom part** in the Parts Library tab — custom parts are
   stored in the project, appear in searches alongside database parts, and can be linked
   like any other (they even work when no database is configured).
7. **Takeoff** (right panel) – live totals across all sheets: device counts, cable
   lengths (measured + drops + wastage %), labour hours and labour $, with material
   cost, quote (retail + labour) and margin. The **Qty** and **Hrs** cells are
   editable — type to manually override any value, leave blank to revert; edited rows
   show a ↺ reset. A global wastage % and labour rate sit at the top. **Export CSV**,
   or **Printable quote** to open a clean, client-ready quote (your business + client
   details, GST %, retail or cost pricing) in a new tab to print or save as PDF.
8. **Save / Open / New** – projects are stored on the server under `projects/`.

Keyboard: `V` select · `C` calibrate · `S` symbol · `L` line · `Enter` finish line ·
`Esc` cancel/deselect · `Delete` remove selection · hold `Space` to pan · scroll to zoom.

## 5. Running fully offline / troubleshooting

The interface uses two JavaScript libraries (Konva for the canvas, pdf.js for PDFs).
By default the app loads them from a CDN, **but if it can't reach the CDN** (no internet
on the browser machine, or a firewall/proxy blocks it) the buttons won't respond —
e.g. **Settings won't open and uploads do nothing**. If you see that, the libraries
didn't load.

Fix it once, for fully offline use:

```bash
python3 fetch_vendor.py     # on any machine that has internet access
```

This downloads `konva.min.js`, `pdf.min.js` and `pdf.worker.min.js` into
`static/vendor/`. The app automatically prefers those local copies (falling back to a
CDN only if they're missing), so after running it the app works with no internet at all.
If the libraries still can't load, the app now shows an on-screen message instead of
silently doing nothing.

(IBM Plex fonts also come from a CDN; offline they simply fall back to a system font —
no functional impact.)

## 6. How data is stored

- **Parts** – your external SQLite/CSV file (read-only; never modified).
- **Projects** – one JSON file per project in `projects/`, containing the sheets
  (with the rasterised plan images), scale, layers, symbols, lines and part links.
- **Settings** – `config.json` next to `server.py`.

## 7. Project structure

```
plan-estimator/
├── server.py            # zero-dependency HTTP backend + parts/projects/settings API
├── make_sample_db.py    # builds data/parts.db (documents the default schema)
├── data/parts.db        # sample parts database
├── projects/            # saved projects (created as you save)
├── static/
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── app.js       # all app logic (canvas, tools, takeoff, projects)
│       └── symbols.js   # electrical/data/mechanical symbol library
└── README.md
```

## 8. Notes / limits

- There is no authentication, by design.
- Plans are rasterised on upload (PDFs capped near 2000px on the long edge) so symbols
  and lines sit on a fixed image; switching a sheet's page clears that sheet's markups.
- Concurrent edits to the same project use last-write-wins.
- Line editing is add/delete (move whole line or delete and redraw); per-vertex editing
  is not included.
