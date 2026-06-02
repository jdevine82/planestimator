/**
 * voltageDrop.js
 * AS/NZS 3008.1.1 Voltage Drop  +  AS/NZS 3000 Appendix B cl B5.2.2
 * Maximum Circuit Length & Earth Fault Loop Impedance
 *
 * ── Voltage Drop (AS/NZS 3008.1.1 Table 30) ──────────────────────────
 *   Vd (V)  = (mV/A/m) × I_load × L / 1000
 *   Vd%     = Vd / V_system × 100
 *   I_load  = 50% of CB rating (distributed circuit assumption)
 *   Limit   = 5% per AS/NZS 3000:2018 cl 3.5.1
 *
 * ── Maximum Route Length (AS/NZS 3000:2018 Appendix B, cl B5.2.2) ────
 *
 *   L_max = (0.8 × Uo × Sph × Spe) / (ρ × Ia × (Sph + Spe))
 *
 *   Where:
 *     Uo   = 230 V  (nominal phase-to-earth voltage)
 *     Sph  = active conductor cross-section (mm²)
 *     Spe  = earth conductor cross-section (mm²)  per AS/NZS 3000 Table 5.1
 *     ρ    = 22.5 × 10⁻³ Ω·mm²/m  (copper at operating temperature, B5.2.2)
 *     Ia   = 7.5 × In  (Type C MCB, per AS/NZS 3000 B5.2.2)
 *     0.8  = voltage availability factor from B5.2.2
 *
 * ── ELFI check (AS/NZS 3000:2018 Appendix B, cl B5.2.2) ─────────────
 *   Zint = ρ × L × (Sph + Spe) / (Sph × Spe)
 *   Pass : Zint ≤ (0.8 × Uo) / Ia
 *
 * ── Earth conductor size (AS/NZS 3000 Table 5.1, copper active) ──────
 *   Active → minimum copper earth (mm²):
 *    1→1   1.5→1.5   2.5→2.5   4→2.5   6→2.5   10→4
 *    16→6   25→6   35→10   50→16   70→25   95→25
 *    120→35   150→50   185→70   240→95   300→120   400→120
 *   (Note: for 1 and 1.5mm² TPS the earth equals the active;
 *    the smaller 2.5mm² earth from Table 5.1 note (a) applies
 *    only to flexible cords / multi-core, not flat TPS.)
 */

(function () {
  "use strict";

  // ── Constants — AS/NZS 3000 Appendix B cl B5.2.2 ────────────────────
  var RHO_CU      = 22.5e-3;   // Ω·mm²/m, copper at operating temp (B5.2.2)
  var UO          = 230;       // V, nominal phase-to-earth voltage
  var V_FACTOR    = 0.8;       // B5.2.2 voltage availability factor
  var IA_FACTOR_C = 7.5;       // Type C MCB: Ia = 7.5 × In (AS/NZS 3000 B5.2.2)
  var VD_LIMIT    = 5.0;       // % max voltage drop, AS/NZS 3000 cl 3.5.1
  var V_1PH       = 230;       // V, single-phase system voltage
  var V_3PH       = 400;       // V, three-phase system voltage (line-to-line)

  // ── AS/NZS 3000 Table 5.1 — copper active → minimum copper earth (mm²)
  // Directly from AS/NZS 3000:2018 Table 5.1, copper active / copper earth column.
  //   1→1, 1.5→1.5, 2.5→2.5, 4→2.5, 6→2.5, 10→4, 16→6, 25→6, 35→10,
  //   50→16, 70→25, 95→25, 120→35, 150→50, 185→70, 240→95, 300→120, 400→120
  var SPE_TABLE = {
    "1":    1,      // Table 5.1: 1mm² active → 1mm² earth
    "1.5":  1.5,    // Table 5.1: 1.5mm² active → 1.5mm² earth
    "2.5":  2.5,    // Table 5.1: 2.5mm² active → 2.5mm² earth
    "4":    2.5,    // Table 5.1: 4mm² active → 2.5mm² earth
    "6":    2.5,    // Table 5.1: 6mm² active → 2.5mm² earth
    "10":   4,      // Table 5.1: 10mm² active → 4mm² earth
    "16":   6,
    "25":   6,
    "35":   10,
    "50":   16,
    "70":   25,
    "95":   25,
    "120":  35,
    "150":  50,
    "185":  70,
    "240":  95,
    "300":  120,
    "400":  120
  };

  // ── AS/NZS 3008.1.1 Table 30 — copper 75°C, mV/A/m ─────────────────
  var VD_TABLE = {
    "1":    { "1ph": 44.0,  "3ph": 38.0  },
    "1.5":  { "1ph": 29.0,  "3ph": 25.0  },
    "2.5":  { "1ph": 18.0,  "3ph": 15.6  },
    "4":    { "1ph": 11.2,  "3ph": 9.7   },
    "6":    { "1ph": 7.50,  "3ph": 6.5   },
    "10":   { "1ph": 4.40,  "3ph": 3.8   },
    "16":   { "1ph": 2.80,  "3ph": 2.4   },
    "25":   { "1ph": 1.75,  "3ph": 1.5   },
    "35":   { "1ph": 1.25,  "3ph": 1.08  },
    "50":   { "1ph": 0.93,  "3ph": 0.80  },
    "70":   { "1ph": 0.64,  "3ph": 0.55  },
    "95":   { "1ph": 0.47,  "3ph": 0.41  },
    "120":  { "1ph": 0.38,  "3ph": 0.33  },
    "150":  { "1ph": 0.31,  "3ph": 0.27  },
    "185":  { "1ph": 0.25,  "3ph": 0.22  },
    "240":  { "1ph": 0.20,  "3ph": 0.17  },
    "300":  { "1ph": 0.16,  "3ph": 0.14  },
    "400":  { "1ph": 0.13,  "3ph": 0.11  }
  };

  // ── Parsers ──────────────────────────────────────────────────────────

  function parseCableSize(raw) {
    if (!raw) return null;
    var n = parseFloat(String(raw).replace(/mm[²2]?/gi, "").trim());
    return isNaN(n) ? null : String(n);
  }

  function parseCbRating(raw) {
    if (!raw) return null;
    var m = String(raw).match(/(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function phaseType(cores) {
    if (!cores) return "1ph";
    var c = String(cores).toUpperCase();
    return (c.indexOf("3C") !== -1 || c.indexOf("4C") !== -1 || c === "SDI") ? "3ph" : "1ph";
  }

  /** Look up Spe from AS/NZS 3000 Table 5.1 for a given active size key */
  function getSpe(sizeKey) {
    var spe = SPE_TABLE[sizeKey];
    return (spe !== undefined) ? spe : null;
  }

  // ── Voltage Drop (AS/NZS 3008.1.1 Table 30) ─────────────────────────

  function calcVd(circuit, lengthM, Iload) {
    if (!circuit || !lengthM || lengthM <= 0) return null;
    var cbA     = parseCbRating(circuit.cbRating);  if (!cbA)     return null;
    var sizeKey = parseCableSize(circuit.cableSize); if (!sizeKey) return null;
    var row     = VD_TABLE[sizeKey];                 if (!row)     return null;

    if (Iload == null) Iload = cbA * 0.5;   // fall back to 50% CB if no device data

    var phase  = phaseType(circuit.cableCores);
    var Vsys   = phase === "3ph" ? V_3PH : V_1PH;
    var mvAm   = row[phase];
    var vdV    = (mvAm * Iload * lengthM) / 1000;
    var vdPct  = (vdV / Vsys) * 100;

    return { vdPct: vdPct, vdV: vdV, current: Iload, phase: phase, Vsys: Vsys };
  }

  // ── Max Route Length + ELFI (AS/NZS 3000 B5.2.2) ────────────────────
  //
  //   Spe from AS/NZS 3000 Table 5.1 (copper active → copper earth).
  //   This correctly accounts for the smaller earth in larger TPS cables.
  //
  //   L_max = (0.8 × Uo × Sph × Spe) / (ρ × Ia × (Sph + Spe))
  //   Zint  = ρ × L   × (Sph + Spe) / (Sph × Spe)
  //   Pass  : Zint ≤ (0.8 × Uo) / Ia

  function calcElfi(circuit, lengthM) {
    var cbA     = parseCbRating(circuit.cbRating);  if (!cbA)     return null;
    var sizeKey = parseCableSize(circuit.cableSize); if (!sizeKey) return null;

    var Sph = parseFloat(sizeKey);
    var Spe = getSpe(sizeKey);
    if (Spe === null) return null;

    var Ia       = IA_FACTOR_C * cbA;
    var Zmax_int = (V_FACTOR * UO) / Ia;
    var Lmax     = (V_FACTOR * UO * Sph * Spe) / (RHO_CU * Ia * (Sph + Spe));
    var Zint     = (lengthM > 0)
                   ? (RHO_CU * lengthM * (Sph + Spe)) / (Sph * Spe)
                   : 0;

    return {
      Lmax:      Lmax,
      Zint:      Zint,
      Zmax_int:  Zmax_int,
      elfiPass:  Zint <= Zmax_int,
      Ia:        Ia,
      Sph:       Sph,
      Spe:       Spe
    };
  }

  // ── Badge HTML builders ──────────────────────────────────────────────

  function statusColor(pass, warn) {
    return pass  ? "var(--accent,#38bdf8)"
         : warn  ? "#f59e0b"
         :         "var(--red,#f87171)";
  }

  function missingTip(circuit, needLength) {
    var miss = [];
    if (!parseCbRating(circuit.cbRating))   miss.push("CB rating");
    if (!parseCableSize(circuit.cableSize)) miss.push("cable size");
    if (needLength)                          miss.push("cable length");
    return miss.length ? "Need: " + miss.join(", ") : "Size not in table";
  }

  function dashSpan(tip) {
    return '<span style="color:var(--faint);font-size:11px" title="' + tip + '">—</span>';
  }

  function vdBadgeHtml(result, lengthM, circuit, currentBasis) {
    if (!result) return dashSpan(missingTip(circuit, !lengthM));
    var pct  = result.vdPct;
    var ok   = pct <= VD_LIMIT;
    var warn = !ok && pct <= VD_LIMIT * 1.2;
    var tip  = result.phase.toUpperCase() + " | " + result.Vsys + " V | "
             + (currentBasis || ("I=" + result.current.toFixed(1) + " A")) + " | "
             + "Vd=" + result.vdV.toFixed(2) + " V | "
             + (ok ? "✓ ≤5% AS3000 cl 3.5.1" : "✗ Exceeds 5% limit");
    return '<span style="font-size:11px;font-family:var(--mono);color:' + statusColor(ok, warn)
         + ';font-weight:600" title="' + tip + '">' + pct.toFixed(1) + '%</span>';
  }

  function elfiBadgeHtml(result, lengthM, circuit) {
    if (!result) return dashSpan(missingTip(circuit, false));
    var pass = result.elfiPass;
    var tip  = "AS/NZS 3000 B5.2.2 | Type C MCB | "
             + "Ia=7.5×" + parseCbRating(circuit.cbRating) + "A=" + result.Ia.toFixed(0) + "A | "
             + "Sph=" + result.Sph + "mm² Spe=" + result.Spe + "mm² (Tbl 5.1) | "
             + "Zint=" + result.Zint.toFixed(3) + "Ω ≤ " + result.Zmax_int.toFixed(3) + "Ω max | "
             + (pass ? "✓ ELFI OK" : "✗ Exceeds limit — shorten run or upsize cable");
    return '<span style="font-size:11px;font-family:var(--mono);color:' + statusColor(pass, false)
         + ';font-weight:600" title="' + tip + '">' + result.Zint.toFixed(2) + "Ω</span>";
  }

  function lmaxBadgeHtml(result, lengthM, circuit) {
    if (!result) return dashSpan(missingTip(circuit, false));
    var ok   = !lengthM || lengthM <= result.Lmax;
    var warn = !ok && lengthM <= result.Lmax * 1.1;
    var used = lengthM ? (lengthM / result.Lmax * 100).toFixed(0) + "% of Lmax" : "no length";
    var tip  = "AS/NZS 3000 B5.2.2 | Lmax=(0.8×Uo×Sph×Spe)/(ρ×Ia×(Sph+Spe)) | "
             + "Sph=" + result.Sph + "mm² Spe=" + result.Spe + "mm² (Tbl 5.1) | "
             + "ρ=22.5×10⁻³ Ω·mm²/m | " + used + " | "
             + (ok ? "✓ Within limit" : "✗ Route too long — increase cable size or add sub-board");
    return '<span style="font-size:11px;font-family:var(--mono);color:' + statusColor(ok, warn)
         + ';font-weight:600" title="' + tip + '">' + result.Lmax.toFixed(0) + "m</span>";
  }

  // ── DOM injection ────────────────────────────────────────────────────

  var ORIG_GRID = "1fr 52px 58px 80px 80px 58px 28px";
  var NEW_GRID  = "1fr 52px 58px 80px 80px 58px 44px 44px 54px 52px 28px";

  function patchRenderCircuitsTable() {
    var _orig = window.renderCircuitsTable;
    if (typeof _orig !== "function") return false;
    window.renderCircuitsTable = function () {
      _orig.apply(this, arguments);
      injectColumns();
    };
    return true;
  }

  function getCircuitLength(cid) {
    var state = window._appState;
    if (!state) return 0;
    var syms = [];
    (state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) {
        if (sym.circuitId === cid) syms.push(sym);
      });
    });
    if (!syms.length) return 0;
    var layerIds = {};
    syms.forEach(function (s) {
      var typeCfg = (state.symbolTypes && state.symbolTypes[s.type]) || {};
      var lid = s.visibleLayerId || typeCfg.palLayerId || null;
      if (lid) layerIds[lid] = true;
    });
    var lineTotal = 0;
    (state.sheets || []).forEach(function (sh) {
      (sh.lines || []).forEach(function (l) {
        if (layerIds[l.layerId]) lineTotal += (l.lengthM || 0);
      });
    });
    var dropTotal = 0;
    syms.forEach(function (s) { dropTotal += (s.dropLength != null) ? s.dropLength : 1; });
    return lineTotal + dropTotal;
  }

  /**
   * Sum current contributions from all symbols assigned to a circuit.
   * Per symbol, uses (in priority order):
   *   1. sym.currentContrib              — explicit per-instance override (Properties panel)
   *   2. symbolTypes[type].defaultCurrentA — seeded from Table C9 at placement time
   *   3. 0 A                             — unknown type with no default
   * Returns null if no symbols are assigned to the circuit.
   */
  /**
   * Resolve the current contribution for a symbol (A).
   * Priority:
   *   1. sym.currentContrib        — per-instance override set in Properties panel
   *   2. symbolTypes[type].defaultCurrentA — type-level default set in Assign Part dialog
   *   3. 0 A                       — no default configured for this type yet
   */
  function resolveContrib(sym) {
    if (sym.currentContrib != null) return sym.currentContrib;
    var state = window._appState || {};
    var typeCfg = (state.symbolTypes && state.symbolTypes[sym.type]) || {};
    if (typeCfg.defaultCurrentA != null) return typeCfg.defaultCurrentA;
    return 0;
  }

  function getCircuitDeviceCurrent(cid) {
    var state = window._appState;
    if (!state) return null;
    var total = 0;
    var count = 0;   // symbols assigned to this circuit
    (state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) {
        if (sym.circuitId !== cid) return;
        total += resolveContrib(sym);
        count++;
      });
    });
    // Return null only when no symbols are assigned — caller shows "—"
    // Return total (even 0) when symbols exist so the column always reflects reality
    return count > 0 ? total : null;
  }

  function injectColumns() {
    var box = document.getElementById("tab-circuits");
    if (!box) return;
    var state    = window._appState || {};
    var circuits = state.circuits || [];

    // Header
    var hdr = box.querySelector("div[style*='" + ORIG_GRID + "']");
    if (hdr && !hdr.querySelector(".vd-hdr")) {
      hdr.style.gridTemplateColumns = NEW_GRID;
      var delSpan = hdr.lastElementChild;
      function mkHdr(cls, label, tip) {
        var s = document.createElement("span");
        s.className = cls; s.title = tip;
        s.style.cssText = "font-size:10px;color:var(--faint);text-align:right;white-space:nowrap";
        s.textContent = label;
        hdr.insertBefore(s, delSpan);
      }
      mkHdr("vd-hdr",   "VD%",  "Voltage drop % — AS/NZS 3008.1.1 Tbl 30, limit 5% (cl 3.5.1). Current basis: device sum or 50% CB.");
      mkHdr("load-hdr", "Load", "Estimated circuit load (A) from all assigned devices using AS/NZS 3000 Table C9. Always shown regardless of VD basis.");
      mkHdr("elfi-hdr", "ELFI", "Internal loop impedance Zint (Ω) — AS/NZS 3000 B5.2.2, Type C Ia=7.5×In, Spe per Tbl 5.1");
      mkHdr("lmax-hdr", "Lmax", "Max one-way route (m) — AS/NZS 3000 B5.2.2, Type C, copper TPS, Spe per Tbl 5.1");
    }

    // Rows
    box.querySelectorAll("div[style*='" + ORIG_GRID + "']").forEach(function (row) {
      if (row.querySelector(".vd-hdr"))  return;
      if (row.querySelector(".vd-cell")) return;
      var inp = row.querySelector("input[data-cid]");
      if (!inp) return;
      var cid = inp.dataset.cid;
      var circuit = circuits.find(function (c) { return c.id === cid; });
      if (!circuit) return;

      var lengthM = getCircuitLength(cid);
      if (!lengthM) {
        var lenSpan = row.querySelector("span[style*='accent']");
        if (lenSpan) { var m = (lenSpan.textContent || "").match(/([\d.]+)/); if (m) lengthM = parseFloat(m[1]); }
      }

      // Resolve load current based on per-circuit checkbox
      var deviceTotal  = getCircuitDeviceCurrent(cid);
      var cbA          = parseCbRating(circuit.cbRating);
      var useDevice    = circuit.useDeviceCurrent && deviceTotal != null;
      var Iload        = useDevice ? deviceTotal : (cbA ? cbA * 0.5 : null);
      var currentBasis = useDevice
        ? ("Device sum: " + deviceTotal.toFixed(2) + " A (Table C9)")
        : ("50% CB: " + (cbA ? (cbA * 0.5).toFixed(1) : "?") + " A");

      var vdResult   = calcVd(circuit, lengthM, Iload);
      var elfiResult = calcElfi(circuit, lengthM);

      row.style.gridTemplateColumns = NEW_GRID;
      var delBtn = row.querySelector("button[data-delcid]");

      function insertCell(cls, html) {
        var div = document.createElement("div");
        div.className = cls;
        div.style.cssText = "text-align:right;display:flex;align-items:center;justify-content:flex-end;padding-right:2px";
        div.innerHTML = html;
        row.insertBefore(div, delBtn);
      }
      insertCell("vd-cell",   vdBadgeHtml(vdResult, lengthM, circuit, currentBasis));
      insertCell("load-cell", loadBadgeHtml(deviceTotal, cbA));
      insertCell("elfi-cell", elfiBadgeHtml(elfiResult, lengthM, circuit));
      insertCell("lmax-cell", lmaxBadgeHtml(elfiResult, lengthM, circuit));
    });

    patchPrintSchedule();
    if (window.refreshLoadMonitor) window.refreshLoadMonitor();
  }

  // ── Load column badge ───────────────────────────────────────────────
  // Always shows the C9 device sum regardless of the VD basis checkbox.

  function loadBadgeHtml(deviceTotal, cbA) {
    if (deviceTotal === null) {
      return '<span style="color:var(--faint);font-size:11px" title="No symbols assigned to this circuit">—</span>';
    }
    var pct  = cbA ? (deviceTotal / cbA) * 100 : null;
    var ok   = pct === null || pct <= 80;
    var warn = pct !== null && pct > 80 && pct <= 100;
    var over = pct !== null && pct > 100;
    var color = over ? "var(--red,#f87171)"
              : warn ? "#f59e0b"
              :        "var(--accent,#38bdf8)";
    var tip = "Device load (Table C9 sum): " + deviceTotal.toFixed(2) + " A"
            + (cbA ? " | CB: " + cbA + " A | " + pct.toFixed(0) + "% of CB rating" : "")
            + (over ? " ✗ Exceeds CB rating!" : warn ? " ⚠ >80% of CB" : " ✓ OK");
    return '<span style="font-size:11px;font-family:var(--mono);color:' + color + ';font-weight:600" title="' + tip + '">'
         + deviceTotal.toFixed(1) + "A</span>";
  }

  // ── Floating load monitor ────────────────────────────────────────────
  // Shows estimated load for the active layer, live as devices are added.
  // Toggled by the ⚡ Load button in the circuits tab header.

  var _monVisible = false;
  var _monEl = null;

  function buildMonitor() {
    if (_monEl) return;
    var el = document.createElement("div");
    el.id = "loadMonitor";
    el.style.cssText = [
      "position:fixed", "bottom:80px", "right:20px", "z-index:500",
      "width:280px", "background:var(--panel,#1a2030)", "border:1px solid var(--border,#2d3748)",
      "border-radius:10px", "box-shadow:0 4px 24px rgba(0,0,0,0.5)",
      "font-family:var(--sans,'IBM Plex Sans',sans-serif)", "font-size:12px",
      "color:var(--text,#e7edf5)", "overflow:hidden", "display:none"
    ].join(";");

    // Header — draggable
    el.innerHTML =
      '<div id="loadMonHdr" style="padding:8px 12px;background:var(--panel-2,#232d3f);display:flex;align-items:center;gap:8px;cursor:move;user-select:none;border-bottom:1px solid var(--border,#2d3748)">' +
        '<span style="font-size:13px">⚡</span>' +
        '<span style="flex:1;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8899aa)">Live Load — Active Layer</span>' +
        '<button id="loadMonClose" style="background:none;border:none;color:var(--muted,#8899aa);cursor:pointer;font-size:14px;padding:0 2px" title="Close">✕</button>' +
      '</div>' +
      '<div id="loadMonBody" style="padding:10px 12px;max-height:320px;overflow-y:auto"></div>';

    document.body.appendChild(el);
    _monEl = el;

    // Close button
    document.getElementById("loadMonClose").onclick = function () {
      _monVisible = false;
      _monEl.style.display = "none";
      updateMonBtn();
    };

    // Drag behaviour
    var hdr = document.getElementById("loadMonHdr");
    var dragging = false, dx = 0, dy = 0;
    hdr.addEventListener("mousedown", function (e) {
      dragging = true;
      dx = e.clientX - _monEl.getBoundingClientRect().left;
      dy = e.clientY - _monEl.getBoundingClientRect().top;
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      _monEl.style.left   = (e.clientX - dx) + "px";
      _monEl.style.top    = (e.clientY - dy) + "px";
      _monEl.style.bottom = "auto";
      _monEl.style.right  = "auto";
    });
    document.addEventListener("mouseup", function () {
      dragging = false;
      document.body.style.userSelect = "";
    });
  }

  function updateMonBtn() {
    var btn = document.getElementById("loadMonBtn");
    if (!btn) return;
    btn.style.background = _monVisible ? "var(--accent,#38bdf8)" : "";
    btn.style.color      = _monVisible ? "#000" : "";
  }

  window.toggleLoadMonitor = function () {
    buildMonitor();
    _monVisible = !_monVisible;
    _monEl.style.display = _monVisible ? "block" : "none";
    updateMonBtn();
    if (_monVisible) window.refreshLoadMonitor();
  };

  window.refreshLoadMonitor = function () {
    if (!_monVisible || !_monEl) return;
    var state = window._appState;
    if (!state) return;

    var lid    = state.activeLayerId;
    var layer  = lid ? (state.layers || []).find(function (l) { return l.id === lid; }) : null;
    var circuits = state.circuits || [];

    // Collect all symbols on this layer, grouped by circuit
    var byCkt = {};   // circuitId → { circuit, syms[] }
    var unassigned = [];

    ;(state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) {
        // Symbol belongs to layer if visibleLayerId matches, or activeLayerId was set at placement
        var symLid = sym.visibleLayerId;
        if (!symLid) {
          var typeCfg = (state.symbolTypes && state.symbolTypes[sym.type]) || {};
          symLid = typeCfg.palLayerId || null;
        }
        if (symLid !== lid) return;

        var contrib = resolveContrib(sym);

        if (sym.circuitId) {
          if (!byCkt[sym.circuitId]) {
            var ckt = circuits.find(function (c) { return c.id === sym.circuitId; });
            byCkt[sym.circuitId] = { circuit: ckt || { name: sym.circuitId, cbRating: "" }, syms: [], total: 0 };
          }
          byCkt[sym.circuitId].syms.push({ sym: sym, contrib: contrib });
          byCkt[sym.circuitId].total += contrib;
        } else {
          unassigned.push({ sym: sym, contrib: contrib });
        }
      });
    });

    var layerName = layer ? layer.name : (lid ? lid : "None");
    var layerColor = layer ? layer.color : "var(--faint)";

    var html = '<div style="font-size:11px;color:' + layerColor + ';font-weight:600;margin-bottom:8px">'
             + '● ' + escHtml(layerName) + '</div>';

    var cktIds = Object.keys(byCkt);
    if (!cktIds.length && !unassigned.length) {
      html += '<div style="color:var(--faint);font-size:11px">No symbols on this layer yet.</div>';
    }

    cktIds.forEach(function (cid) {
      var entry  = byCkt[cid];
      var c      = entry.circuit;
      var cbA    = parseCbRating(c.cbRating);
      var total  = entry.total;
      var pct    = cbA ? (total / cbA) * 100 : null;
      var over   = pct !== null && pct > 100;
      var warn   = pct !== null && pct > 80 && !over;
      var barColor = over ? "#f87171" : warn ? "#f59e0b" : "#38bdf8";
      var barW   = pct !== null ? Math.min(pct, 100).toFixed(0) : 0;

      html +=
        '<div style="margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
            '<span style="font-weight:500;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(c.name) + '">' + escHtml(c.name) + '</span>' +
            '<span style="font-family:var(--mono);font-size:11px;color:' + barColor + '">' +
              total.toFixed(1) + 'A' + (cbA ? ' / ' + cbA + 'A' : '') +
            '</span>' +
          '</div>' +
          '<div style="background:var(--bg-alt,#111827);border-radius:3px;height:5px;overflow:hidden">' +
            '<div style="height:100%;width:' + barW + '%;background:' + barColor + ';border-radius:3px;transition:width .3s"></div>' +
          '</div>' +
          '<div style="margin-top:4px;font-size:10px;color:var(--faint)">' +
            entry.syms.map(function (s) {
              return escHtml(s.sym.type.replace(/_/g," ")) + ' ' + s.contrib.toFixed(1) + 'A';
            }).join(' · ') +
          '</div>' +
        '</div>';
    });

    if (unassigned.length) {
      var uTotal = unassigned.reduce(function (s, x) { return s + x.contrib; }, 0);
      html +=
        '<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
            '<span style="color:var(--faint);font-size:11px">Unassigned</span>' +
            '<span style="font-family:var(--mono);font-size:11px;color:var(--faint)">' + uTotal.toFixed(1) + 'A</span>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--faint)">' +
            unassigned.map(function (s) {
              return escHtml(s.sym.type.replace(/_/g," ")) + ' ' + s.contrib.toFixed(1) + 'A';
            }).join(' · ') +
          '</div>' +
        '</div>';
    }

    document.getElementById("loadMonBody").innerHTML = html;
  };

  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // ── Print schedule ───────────────────────────────────────────────────
  var _printPatched = false;
  function patchPrintSchedule() {
    if (_printPatched) return;
    var _origPrint = window.printCircuitSchedule;
    if (typeof _origPrint !== "function") return;
    _printPatched = true;

    window.printCircuitSchedule = function () {
      var state    = window._appState || {};
      var circuits = state.circuits || [];
      var projName = state.name || "Untitled project";

      var rows = circuits.map(function (c, idx) {
        var lengthM   = getCircuitLength(c.id);
        var lenStr    = lengthM ? lengthM.toFixed(1) + " m" : "—";
        var deviceTotal = getCircuitDeviceCurrent(c.id);
        var cbA         = parseCbRating(c.cbRating);
        var useDevice   = c.useDeviceCurrent && deviceTotal != null;
        var Iload       = useDevice ? deviceTotal : (cbA ? cbA * 0.5 : null);
        var basisStr    = useDevice
          ? deviceTotal.toFixed(2) + " A (dev)"
          : (cbA ? (cbA * 0.5).toFixed(1) + " A (50%CB)" : "—");
        var vd        = calcVd(c, lengthM, Iload);
        var elfi      = calcElfi(c, lengthM);
        var vdStr     = vd   ? vd.vdPct.toFixed(1)  + "%" : "—";
        var elfiStr   = elfi ? elfi.Zint.toFixed(2) + " Ω" : "—";
        var lmaxStr   = elfi ? elfi.Lmax.toFixed(0) + " m" : "—";
        var speStr    = elfi ? "(" + elfi.Sph + "/" + elfi.Spe + "mm²)" : "";
        var vdOk      = vd   && vd.vdPct  <= VD_LIMIT;
        var elfiOk    = elfi && elfi.elfiPass;
        var lmaxOk    = elfi && (!lengthM || lengthM <= elfi.Lmax);

        function cell(val, ok, center) {
          var st = center ? "text-align:center;" : "";
          if (ok === true)  st += "color:#166534;background:#dcfce7;border-radius:3px;padding:1px 4px;";
          if (ok === false) st += "color:#991b1b;background:#fee2e2;border-radius:3px;padding:1px 4px;";
          return '<td style="' + st + '">' + val + '</td>';
        }

        var bg = idx % 2 === 0 ? "#ffffff" : "#f4f6f9";
        var devLoadStr = deviceTotal != null ? deviceTotal.toFixed(1) + " A" : "—";
        var devLoadOk  = deviceTotal != null && cbA ? (deviceTotal <= cbA ? true : false) : null;
        return '<tr style="background:' + bg + '">'
          + '<td>' + (c.name || "—") + '</td>'
          + cell(c.cbRating  || "—",  null,      true)
          + cell(devLoadStr,           devLoadOk, true)
          + cell((c.cableSize || "—") + " " + speStr, null, true)
          + cell(c.cableCores || "—", null, true)
          + cell(c.cableType  || "—", null, true)
          + cell(lenStr,    null,   true)
          + cell(basisStr,  null,   true)
          + cell(vdStr,     vd   ? vdOk  : null, true)
          + cell(elfiStr,   elfi ? elfiOk : null, true)
          + cell(lmaxStr,   elfi ? lmaxOk : null, true)
          + '</tr>';
      }).join("");

      var html =
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<title>Circuit Schedule — ' + projName + '</title>'
        + '<style>'
        + '* { box-sizing:border-box; margin:0; padding:0; }'
        + 'body { font-family:Arial,Helvetica,sans-serif; font-size:11px; color:#111; padding:15mm 12mm; }'
        + 'h1 { font-size:17px; margin-bottom:4px; }'
        + '.meta { color:#555; font-size:10px; margin-bottom:3px; }'
        + '.note { color:#555; font-size:9px; margin-bottom:14px; font-style:italic; }'
        + 'table { width:100%; border-collapse:collapse; margin-top:6px; }'
        + 'thead tr { background:#2a3340 !important; }'
        + 'th { color:#fff; padding:7px 8px; text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.4px; }'
        + 'th.c, td.c { text-align:center; }'
        + 'td { padding:6px 8px; border-bottom:1px solid #ddd; vertical-align:middle; }'
        + '.btn-print { display:inline-block; margin-bottom:14px; padding:7px 18px; background:#ffb02e; border:none; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; }'
        + '@media print { .no-print { display:none !important; } }'
        + '</style></head><body>'
        + '<div class="no-print" style="margin-bottom:14px"><button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button></div>'
        + '<h1>Circuit Schedule</h1>'
        + '<p class="meta">Project: <strong>' + projName + '</strong>&nbsp;&nbsp;|&nbsp;&nbsp;Date: ' + new Date().toLocaleDateString("en-AU") + '</p>'
        + '<p class="note">'
        + 'Dev load: sum of device currents per AS/NZS 3000 Table C9 (green ≤CB, red >CB). &nbsp;|&nbsp; VD%: AS/NZS 3008.1.1 Tbl 30, copper 75°C. VD basis — 50% CB or device sum when "Use device A" checked. Limit 5% per AS/NZS 3000 cl 3.5.1. &nbsp;|&nbsp; '
        + 'ELFI &amp; Lmax: AS/NZS 3000:2018 Appendix B cl B5.2.2, Type C MCB (Ia=7.5×In), '
        + 'Lmax=(0.8×Uo×Sph×Spe)/(ρ×Ia×(Sph+Spe)), ρ=22.5×10⁻³ Ω·mm²/m. '
        + 'Spe from AS/NZS 3000 Table 5.1 (copper active, copper earth). '
        + 'Cable size column shows active/earth (mm²).'
        + '</p>'
        + '<table><thead><tr>'
        + '<th>Circuit name</th><th class="c">CB</th><th class="c">Dev load</th><th class="c">Size (act/earth)</th>'
        + '<th class="c">Cores</th><th class="c">Type</th><th class="c">Length</th>'
        + '<th class="c">VD%</th><th class="c">Load I</th><th class="c">ELFI (Ω)</th><th class="c">Lmax (m)</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>'
        + '<script>setTimeout(function(){ window.print(); }, 500);<\/script>'
        + '</body></html>';

      var w = window.open("", "_blank");
      if (w) { w.document.write(html); w.document.close(); }
    };
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  window.asCircuitCalc = {
    calcVd: calcVd, calcElfi: calcElfi,
    parseCableSize: parseCableSize, parseCbRating: parseCbRating,
    getSpe: getSpe, getCircuitDeviceCurrent: getCircuitDeviceCurrent,
    VD_TABLE: VD_TABLE, SPE_TABLE: SPE_TABLE,
    VD_LIMIT: VD_LIMIT, RHO_CU: RHO_CU, UO: UO, IA_FACTOR_C: IA_FACTOR_C
  };

  var _attempts = 0;
  function tryPatch() {
    _attempts++;
    if (patchRenderCircuitsTable()) {
      if (!window.getAppState) window.getAppState = function () { return window._appState || null; };
      // Install the enhanced print schedule now that app.js has run
      patchPrintSchedule();
      if (typeof window.renderCircuitsTable === "function") window.renderCircuitsTable();
    } else if (_attempts < 30) {
      setTimeout(tryPatch, 200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(tryPatch, 900);
    });
  } else {
    setTimeout(tryPatch, 900);
  }

})();
