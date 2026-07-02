/**
 * voltageDrop.js
 * AS/NZS 3008.1.1 Voltage Drop  +  AS/NZS 3000 Appendix B cl B5.2.2
 * Maximum Circuit Length & Earth Fault Loop Impedance
 * AS/NZS 3008.1.1 Derating (installation conditions, grouping, ambient temp)
 */

(function () {
  "use strict";

  // ── Constants — AS/NZS 3000 Appendix B cl B5.2.2 ────────────────────
  var RHO_CU      = 22.5e-3;
  var UO          = 230;
  var V_FACTOR    = 0.8;
  var IA_FACTOR_C = 7.5;
  var VD_LIMIT    = 5.0;
  var V_1PH       = 230;
  var V_3PH       = 400;

  // ── AS/NZS 3000 Table 5.1 — copper active → minimum copper earth (mm²)
  var SPE_TABLE = {
    "1":1,"1.5":1.5,"2.5":2.5,"4":2.5,"6":2.5,"10":4,
    "16":6,"25":6,"35":10,"50":16,"70":25,"95":25,
    "120":35,"150":50,"185":70,"240":95,"300":120,"400":120
  };

  // ── AS/NZS 3008.1.1 Table 30 — copper 75°C, mV/A/m ─────────────────
  var VD_TABLE = {
    "1":   {"1ph":44.0,"3ph":38.0},"1.5": {"1ph":29.0,"3ph":25.0},
    "2.5": {"1ph":18.0,"3ph":15.6},"4":   {"1ph":11.2,"3ph":9.7},
    "6":   {"1ph":7.50,"3ph":6.5}, "10":  {"1ph":4.40,"3ph":3.8},
    "16":  {"1ph":2.80,"3ph":2.4}, "25":  {"1ph":1.75,"3ph":1.5},
    "35":  {"1ph":1.25,"3ph":1.08},"50":  {"1ph":0.93,"3ph":0.80},
    "70":  {"1ph":0.64,"3ph":0.55},"95":  {"1ph":0.47,"3ph":0.41},
    "120": {"1ph":0.38,"3ph":0.33},"150": {"1ph":0.31,"3ph":0.27},
    "185": {"1ph":0.25,"3ph":0.22},"240": {"1ph":0.20,"3ph":0.17},
    "300": {"1ph":0.16,"3ph":0.14},"400": {"1ph":0.13,"3ph":0.11}
  };

  // ── AS/NZS 3008.1.1 Derating — current-carrying capacity (A) ────────
  // Copper multicore cables. Source: AS/NZS 3008.1.1:2017 Table 4.
  // Reference ambient: 40°C (air), 25°C (underground), soil ρ=1.2 K·m/W.
  // Verify against current edition before use in design.
  //
  // Methods: insulation | clipped | conduit_air | ug_conduit | ug_direct
  // Insulation: v75 (75°C thermo-plastic PVC) | v90 (90°C thermo-plastic PVC)
  //             xlpe_90 (90°C thermo-setting XLPE/EPR) | xlpe_110 (110°C thermo-setting XLPE/EPR)
  // xlpe_90 uses a separate AS3008 column from v90 — thermosetting has higher ratings.
  // xlpe_110 uses Tmax=110°C for the ambient temperature correction factor.
  // Existing circuits saved with derateInsul="xlpe" are mapped to xlpe_90.
  var DERATE = {
    insulation: {
      v75:      {"1":11,"1.5":14,"2.5":18,"4":24,"6":31,"10":43,"16":57,"25":75,"35":92,"50":112,"70":143,"95":174,"120":201,"150":232,"185":268,"240":316,"300":365,"400":420},
      v90:      {"1":13,"1.5":16,"2.5":21,"4":28,"6":36,"10":49,"16":65,"25":86,"35":106,"50":128,"70":163,"95":198,"120":229,"150":264,"185":305,"240":360,"300":415,"400":475},
      xlpe_90:  {"1":14,"1.5":17,"2.5":23,"4":31,"6":39,"10":53,"16":71,"25":94,"35":116,"50":140,"70":178,"95":216,"120":249,"150":288,"185":332,"240":392,"300":453,"400":518},
      xlpe_110: {"1":17,"1.5":20,"2.5":27,"4":37,"6":46,"10":63,"16":84,"25":111,"35":137,"50":165,"70":210,"95":255,"120":294,"150":339,"185":392,"240":463,"300":534,"400":611}
    },
    clipped: {
      v75:      {"1":15,"1.5":19,"2.5":26,"4":34,"6":44,"10":60,"16":80,"25":105,"35":128,"50":156,"70":200,"95":243,"120":282,"150":325,"185":375,"240":443,"300":511,"400":590},
      v90:      {"1":17,"1.5":22,"2.5":30,"4":40,"6":51,"10":69,"16":91,"25":119,"35":146,"50":176,"70":224,"95":272,"120":314,"150":362,"185":416,"240":491,"300":565,"400":650},
      xlpe_90:  {"1":19,"1.5":24,"2.5":33,"4":44,"6":56,"10":76,"16":100,"25":131,"35":161,"50":194,"70":246,"95":299,"120":345,"150":398,"185":458,"240":540,"300":622,"400":715},
      xlpe_110: {"1":22,"1.5":28,"2.5":39,"4":52,"6":66,"10":90,"16":118,"25":155,"35":190,"50":229,"70":290,"95":353,"120":407,"150":470,"185":541,"240":637,"300":734,"400":844}
    },
    conduit_air: {
      v75:      {"1":13,"1.5":16,"2.5":22,"4":29,"6":37,"10":51,"16":67,"25":87,"35":107,"50":130,"70":165,"95":200,"120":232,"150":267,"185":308,"240":363,"300":420,"400":485},
      v90:      {"1":15,"1.5":18,"2.5":25,"4":34,"6":44,"10":59,"16":78,"25":100,"35":123,"50":149,"70":189,"95":230,"120":265,"150":305,"185":351,"240":413,"300":476,"400":550},
      xlpe_90:  {"1":17,"1.5":20,"2.5":28,"4":37,"6":48,"10":65,"16":86,"25":110,"35":135,"50":164,"70":208,"95":253,"120":292,"150":336,"185":386,"240":454,"300":524,"400":605},
      xlpe_110: {"1":20,"1.5":24,"2.5":33,"4":44,"6":57,"10":77,"16":101,"25":130,"35":159,"50":194,"70":245,"95":298,"120":344,"150":396,"185":455,"240":536,"300":618,"400":714}
    },
    ug_conduit: {
      v75:      {"1":14,"1.5":17,"2.5":23,"4":31,"6":40,"10":54,"16":71,"25":94,"35":115,"50":140,"70":178,"95":216,"120":250,"150":288,"185":332,"240":392,"300":452,"400":520},
      v90:      {"1":16,"1.5":20,"2.5":26,"4":36,"6":46,"10":62,"16":82,"25":107,"35":132,"50":160,"70":202,"95":246,"120":284,"150":328,"185":377,"240":446,"300":515,"400":590},
      xlpe_90:  {"1":17,"1.5":21,"2.5":28,"4":38,"6":49,"10":66,"16":87,"25":113,"35":140,"50":170,"70":214,"95":261,"120":301,"150":348,"185":400,"240":473,"300":546,"400":625},
      xlpe_110: {"1":20,"1.5":25,"2.5":33,"4":45,"6":58,"10":78,"16":103,"25":133,"35":165,"50":200,"70":252,"95":308,"120":355,"150":411,"185":472,"240":558,"300":644,"400":737}
    },
    ug_direct: {
      v75:      {"1":16,"1.5":20,"2.5":27,"4":36,"6":47,"10":64,"16":84,"25":110,"35":135,"50":164,"70":208,"95":252,"120":292,"150":336,"185":387,"240":456,"300":525,"400":605},
      v90:      {"1":18,"1.5":23,"2.5":31,"4":42,"6":54,"10":73,"16":96,"25":125,"35":154,"50":188,"70":238,"95":288,"120":332,"150":384,"185":441,"240":520,"300":598,"400":688},
      xlpe_90:  {"1":19,"1.5":24,"2.5":33,"4":45,"6":57,"10":77,"16":102,"25":133,"35":163,"50":199,"70":252,"95":305,"120":352,"150":407,"185":468,"240":551,"300":634,"400":730},
      xlpe_110: {"1":22,"1.5":28,"2.5":39,"4":53,"6":67,"10":91,"16":120,"25":157,"35":192,"50":235,"70":297,"95":360,"120":415,"150":480,"185":552,"240":650,"300":748,"400":861}
    }
  };

  // Grouping derating factors — AS/NZS 3008.1.1 Table 25 (cables touching)
  // [minN, Cg]
  var CGF = [[1,1.00],[2,0.80],[3,0.70],[4,0.65],[5,0.60],[6,0.57],[7,0.53],[9,0.50],[12,0.45],[16,0.41],[20,0.38]];

  function getGroupFactor(n) {
    var f = 1.0;
    for (var i = 0; i < CGF.length; i++) {
      if (n >= CGF[i][0]) f = CGF[i][1]; else break;
    }
    return f;
  }

  function getAmbFactor(insulType, method, ambTemp) {
    var Tmax = (insulType === "v75") ? 75 : (insulType === "xlpe_110") ? 110 : 90;
    var isUG = (method === "ug_conduit" || method === "ug_direct");
    var Tref = isUG ? 25 : 40;
    if (ambTemp === Tref) return 1.0;
    var r = (Tmax - ambTemp) / (Tmax - Tref);
    return r <= 0 ? 0 : Math.sqrt(r);
  }

  function calcDerating(circuit) {
    var sizeKey = parseCableSize(circuit.cableSize);
    if (!sizeKey) return null;
    var method  = circuit.derateMethod  || "insulation";
    var insul   = circuit.derateInsul   || "v90";
    // Migrate legacy "xlpe" key saved by earlier version to xlpe_90
    if (insul === "xlpe") insul = "xlpe_90";
    var bunched = Math.max(1, parseInt(circuit.derateBunched) || 1);
    var isUG    = (method === "ug_conduit" || method === "ug_direct");
    var ambTemp = parseFloat(circuit.derateAmbient);
    if (isNaN(ambTemp)) ambTemp = isUG ? 25 : 40;
    var tbl = DERATE[method]; if (!tbl) return null;
    var row = tbl[insul] || tbl["v90"];
    var Ibase = row[sizeKey]; if (Ibase == null) return null;
    var Cg = getGroupFactor(bunched);
    var Ca = getAmbFactor(insul, method, ambTemp);
    return { Ibase: Ibase, Cg: Cg, Ca: Ca, Iderated: Ibase * Cg * Ca, method: method, insul: insul, bunched: bunched, ambTemp: ambTemp };
  }

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
    if (Iload == null) Iload = cbA * 0.5;
    var phase  = phaseType(circuit.cableCores);
    var Vsys   = phase === "3ph" ? V_3PH : V_1PH;
    var mvAm   = row[phase];
    var vdV    = (mvAm * Iload * lengthM) / 1000;
    var vdPct  = (vdV / Vsys) * 100;
    return { vdPct: vdPct, vdV: vdV, current: Iload, phase: phase, Vsys: Vsys };
  }

  // ── Max Route Length + ELFI (AS/NZS 3000 B5.2.2) ────────────────────

  function calcElfi(circuit, lengthM) {
    var cbA     = parseCbRating(circuit.cbRating);  if (!cbA)     return null;
    var sizeKey = parseCableSize(circuit.cableSize); if (!sizeKey) return null;
    var Sph = parseFloat(sizeKey);
    var Spe = getSpe(sizeKey); if (Spe === null) return null;
    var Ia       = IA_FACTOR_C * cbA;
    var Zmax_int = (V_FACTOR * UO) / Ia;
    var Lmax     = (V_FACTOR * UO * Sph * Spe) / (RHO_CU * Ia * (Sph + Spe));
    var Zint     = (lengthM > 0) ? (RHO_CU * lengthM * (Sph + Spe)) / (Sph * Spe) : 0;
    return { Lmax: Lmax, Zint: Zint, Zmax_int: Zmax_int, elfiPass: Zint <= Zmax_int, Ia: Ia, Sph: Sph, Spe: Spe };
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

  var METHOD_LABELS = { insulation:"In insulation", clipped:"Clipped/free air", conduit_air:"Conduit/air", ug_conduit:"UG conduit", ug_direct:"UG direct" };
  var INSUL_LABELS  = { v75:"V-75", v90:"V-90", xlpe_90:"XLPE 90°C", xlpe_110:"XLPE 110°C", xlpe:"XLPE 90°C" };

  function derateCellHtml(result, circuit, cid) {
    var btn = '<button data-derate-cid="' + cid + '" style="background:none;border:none;color:var(--muted,#8899aa);cursor:pointer;font-size:10px;padding:0 1px;line-height:1" title="Derating settings (AS3008.1.1)">&#9881;</button>';
    if (!result) {
      var tip = parseCableSize(circuit.cableSize) ? "Size not in AS3008 table" : "Enter cable size to calculate";
      return '<span style="color:var(--faint);font-size:11px" title="' + tip + '">—</span>' + btn;
    }
    var cbA  = parseCbRating(circuit.cbRating);
    var ok   = cbA ? result.Iderated >= cbA : null;
    var warn = cbA && ok === false && result.Iderated >= cbA * 0.9;
    var color = ok === null ? "var(--muted)"
              : ok   ? "var(--accent,#38bdf8)"
              : warn ? "#f59e0b"
              :        "var(--red,#f87171)";
    var tip = "AS3008.1.1 | " + (METHOD_LABELS[result.method] || result.method)
            + " | " + (INSUL_LABELS[result.insul] || result.insul)
            + " | Ibase=" + result.Ibase + "A × Cg=" + result.Cg.toFixed(2) + " × Ca=" + result.Ca.toFixed(2)
            + " = " + result.Iderated.toFixed(1) + "A"
            + (cbA ? (ok ? " ✓ ≥ CB (" + cbA + "A)" : " ✗ < CB (" + cbA + "A) — upsize cable") : "")
            + " | Click ⚙ to edit";
    return '<span style="font-size:11px;font-family:var(--mono);color:' + color + ';font-weight:600" title="' + tip + '">'
         + result.Iderated.toFixed(1) + 'A</span>' + btn;
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
  // app.js renders base grid "1fr 52px 58px 80px 80px 58px 28px"
  // We expand it to include Cable I (after CB) + VD/Load/ELFI/Lmax (before Del)

  var ORIG_GRID = "1fr 52px 58px 80px 80px 58px 28px";
  var NEW_GRID  = "1fr 52px 60px 58px 80px 80px 58px 44px 44px 54px 52px 28px";

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
    var state = window._appState; if (!state) return 0;
    var syms = [];
    (state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) { if (sym.circuitId === cid) syms.push(sym); });
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
      (sh.lines || []).forEach(function (l) { if (layerIds[l.layerId]) lineTotal += (l.lengthM || 0); });
    });
    var dropTotal = 0;
    syms.forEach(function (s) { dropTotal += (s.dropLength != null) ? s.dropLength : 1; });
    return lineTotal + dropTotal;
  }

  function resolveContrib(sym) {
    if (sym.currentContrib != null) return sym.currentContrib;
    var state = window._appState || {};
    var typeCfg = (state.symbolTypes && state.symbolTypes[sym.type]) || {};
    if (typeCfg.defaultCurrentA != null) return typeCfg.defaultCurrentA;
    return 0;
  }

  function getCircuitDeviceCurrent(cid) {
    var state = window._appState; if (!state) return null;
    var total = 0, count = 0;
    (state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) {
        if (sym.circuitId !== cid) return;
        total += resolveContrib(sym); count++;
      });
    });
    return count > 0 ? total : null;
  }

  function injectColumns() {
    var box = document.getElementById("tab-circuits"); if (!box) return;
    var state    = window._appState || {};
    var circuits = state.circuits || [];

    // ── Header ──
    var hdr = box.querySelector("div[style*='" + ORIG_GRID + "']");
    if (hdr && !hdr.querySelector(".vd-hdr")) {
      hdr.style.gridTemplateColumns = NEW_GRID;

      function mkSpan(cls, label, tip, insertBefore) {
        var s = document.createElement("span");
        s.className = cls; s.title = tip;
        s.style.cssText = "font-size:10px;color:var(--faint);text-align:right;white-space:nowrap";
        s.textContent = label;
        hdr.insertBefore(s, insertBefore);
      }

      // Insert "Cable I" header before Size header (children[2])
      mkSpan("derate-hdr", "Cable I",
        "Derated cable ampacity (A) per AS/NZS 3008.1.1. Click ⚙ on a circuit to set installation conditions. Verify values against current edition.",
        hdr.children[2]);

      // Insert VD%, Load, ELFI, Lmax before Delete placeholder
      var del = hdr.lastElementChild;
      mkSpan("vd-hdr",   "VD%",  "Voltage drop % — AS/NZS 3008.1.1 Tbl 30, limit 5% (cl 3.5.1).", del);
      mkSpan("load-hdr", "Load", "Estimated circuit load (A) — device sum per AS/NZS 3000 Table C9.", del);
      mkSpan("elfi-hdr", "ELFI", "Loop impedance Zint (Ω) — AS/NZS 3000 B5.2.2, Type C Ia=7.5×In.", del);
      mkSpan("lmax-hdr", "Lmax", "Max one-way route (m) — AS/NZS 3000 B5.2.2, Type C, Spe per Tbl 5.1.", del);
    }

    // ── Rows ──
    box.querySelectorAll("div[style*='" + ORIG_GRID + "']").forEach(function (row) {
      if (row.querySelector(".vd-hdr"))     return;
      if (row.querySelector(".derate-cell")) return;
      var inp = row.querySelector("input[data-cid]"); if (!inp) return;
      var cid = inp.dataset.cid;
      var circuit = circuits.find(function (c) { return c.id === cid; }); if (!circuit) return;

      var lengthM = getCircuitLength(cid);
      if (!lengthM) {
        var lenSpan = row.querySelector("span[style*='accent']");
        if (lenSpan) { var m = (lenSpan.textContent || "").match(/([\d.]+)/); if (m) lengthM = parseFloat(m[1]); }
      }

      var deviceTotal  = getCircuitDeviceCurrent(cid);
      var cbA          = parseCbRating(circuit.cbRating);
      var useDevice    = circuit.useDeviceCurrent && deviceTotal != null;
      var Iload        = useDevice ? deviceTotal : (cbA ? cbA * 0.5 : null);
      var currentBasis = useDevice
        ? ("Device sum: " + deviceTotal.toFixed(2) + " A (Table C9)")
        : ("50% CB: " + (cbA ? (cbA * 0.5).toFixed(1) : "?") + " A");

      var vdResult    = calcVd(circuit, lengthM, Iload);
      var elfiResult  = calcElfi(circuit, lengthM);
      var drResult    = calcDerating(circuit);

      row.style.gridTemplateColumns = NEW_GRID;

      // Insert Cable I cell BEFORE cableSize input
      var sizeInp = row.querySelector("input[data-field='cableSize']");
      var dCell = document.createElement("div");
      dCell.className = "derate-cell";
      dCell.style.cssText = "text-align:right;display:flex;align-items:center;justify-content:flex-end;padding-right:2px;gap:1px";
      dCell.innerHTML = derateCellHtml(drResult, circuit, cid);
      row.insertBefore(dCell, sizeInp);
      var drBtn = dCell.querySelector("[data-derate-cid]");
      if (drBtn) drBtn.onclick = function (e) { e.stopPropagation(); openDerateModal(cid); };

      // Insert VD/Load/ELFI/Lmax BEFORE delete button
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

  // ── Load column badge ─────────────────────────────────────────────────

  function loadBadgeHtml(deviceTotal, cbA) {
    if (deviceTotal === null) {
      return '<span style="color:var(--faint);font-size:11px" title="No symbols assigned to this circuit">—</span>';
    }
    var pct  = cbA ? (deviceTotal / cbA) * 100 : null;
    var ok   = pct === null || pct <= 80;
    var warn = pct !== null && pct > 80 && pct <= 100;
    var over = pct !== null && pct > 100;
    var color = over ? "var(--red,#f87171)" : warn ? "#f59e0b" : "var(--accent,#38bdf8)";
    var tip = "Device load (Table C9 sum): " + deviceTotal.toFixed(2) + " A"
            + (cbA ? " | CB: " + cbA + " A | " + pct.toFixed(0) + "% of CB rating" : "")
            + (over ? " ✗ Exceeds CB rating!" : warn ? " ⚠ >80% of CB" : " ✓ OK");
    return '<span style="font-size:11px;font-family:var(--mono);color:' + color + ';font-weight:600" title="' + tip + '">'
         + deviceTotal.toFixed(1) + "A</span>";
  }

  // ── Derating Modal ────────────────────────────────────────────────────

  var _dModal = null;
  var _dModalCid = null;

  function buildDerateModal() {
    if (_dModal) return;
    var el = document.createElement("div");
    el.id = "derateModal";
    el.style.cssText = [
      "position:fixed","top:50%","left:50%","transform:translate(-50%,-50%)",
      "z-index:600","width:370px","background:var(--panel,#1a2030)",
      "border:1px solid var(--border,#2d3748)","border-radius:10px",
      "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
      "font-family:var(--sans,'IBM Plex Sans',sans-serif)",
      "font-size:13px","color:var(--text,#e7edf5)","display:none"
    ].join(";");

    el.innerHTML =
      '<div style="padding:10px 16px;background:var(--panel-2,#232d3f);display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border,#2d3748);border-radius:10px 10px 0 0">' +
        '<span style="flex:1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8899aa)">Derating — <span id="dModalName" style="color:var(--text,#e7edf5)"></span></span>' +
        '<button id="dModalClose" style="background:none;border:none;color:var(--muted,#8899aa);cursor:pointer;font-size:14px;padding:0 2px">✕</button>' +
      '</div>' +
      '<div style="padding:14px 16px">' +

        // Installation method
        '<div style="margin-bottom:11px">' +
          '<div style="font-size:10px;color:var(--muted,#8899aa);text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px">Installation method</div>' +
          '<select id="dMethodSel" style="width:100%;padding:5px 8px;background:var(--bg-alt,#111827);border:1px solid var(--border,#2d3748);border-radius:4px;color:var(--text,#e7edf5);color-scheme:dark;font-size:12px">' +
            '<option value="insulation">In thermal insulation (wall / ceiling)</option>' +
            '<option value="clipped">Clipped direct / free air</option>' +
            '<option value="conduit_air">In conduit — free air</option>' +
            '<option value="ug_conduit">In conduit — underground</option>' +
            '<option value="ug_direct">Direct buried — underground</option>' +
          '</select>' +
        '</div>' +

        // Insulation rating
        '<div style="margin-bottom:11px">' +
          '<div style="font-size:10px;color:var(--muted,#8899aa);text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px">Insulation rating</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px">' +
            '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="dInsul" value="v75" style="accent-color:var(--accent,#38bdf8)"> V-75 (75°C PVC)</label>' +
            '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="dInsul" value="v90" style="accent-color:var(--accent,#38bdf8)"> V-90 (90°C PVC)</label>' +
            '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="dInsul" value="xlpe_90" style="accent-color:var(--accent,#38bdf8)"> XLPE/EPR 90°C</label>' +
            '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="dInsul" value="xlpe_110" style="accent-color:var(--accent,#38bdf8)"> XLPE/EPR 110°C</label>' +
          '</div>' +
        '</div>' +

        // Grouping + Ambient side by side
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div>' +
            '<div style="font-size:10px;color:var(--muted,#8899aa);text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px">Cables bunched</div>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<select id="dBunchedSel" style="flex:1;padding:5px 6px;background:var(--bg-alt,#111827);border:1px solid var(--border,#2d3748);border-radius:4px;color:var(--text,#e7edf5);color-scheme:dark;font-size:12px">' +
                '<option value="1">1 — not grouped</option>' +
                '<option value="2">2</option><option value="3">3</option><option value="4">4</option>' +
                '<option value="5">5</option><option value="6">6</option><option value="7">7</option>' +
                '<option value="9">8–9</option><option value="12">10–12</option>' +
                '<option value="16">13–16</option><option value="20">17–20</option>' +
              '</select>' +
              '<div style="min-width:38px;text-align:center"><div style="font-size:9px;color:var(--faint)">Cg</div><div id="dCgVal" style="font-family:var(--mono);font-size:12px;color:var(--accent,#38bdf8)">1.00</div></div>' +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:var(--muted,#8899aa);text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px"><span id="dAmbLabel">Ambient air temp</span></div>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<input id="dAmbInp" type="number" step="1" style="flex:1;padding:5px 6px;background:var(--bg-alt,#111827);border:1px solid var(--border,#2d3748);border-radius:4px;color:var(--text,#e7edf5);color-scheme:dark;font-size:12px">' +
              '<span style="font-size:11px;color:var(--faint)">°C</span>' +
              '<div style="min-width:38px;text-align:center"><div style="font-size:9px;color:var(--faint)">Ca</div><div id="dCaVal" style="font-family:var(--mono);font-size:12px;color:var(--accent,#38bdf8)">1.00</div></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Result preview
        '<div id="dResult" style="background:var(--bg-alt,#111827);border-radius:6px;padding:9px 12px;font-size:12px;margin-bottom:12px;border:1px solid var(--border,#2d3748);min-height:52px"></div>' +

        // Buttons
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<button id="dApplyAll" style="padding:5px 10px;background:var(--panel-2,#232d3f);border:1px solid var(--border,#2d3748);border-radius:5px;color:var(--muted,#8899aa);cursor:pointer;font-size:11px">Apply to all</button>' +
          '<div style="flex:1"></div>' +
          '<button id="dCancel" style="padding:5px 14px;background:var(--panel-2,#232d3f);border:1px solid var(--border,#2d3748);border-radius:5px;color:var(--text,#e7edf5);cursor:pointer;font-size:12px">Cancel</button>' +
          '<button id="dApply" style="padding:5px 14px;background:var(--accent,#38bdf8);border:none;border-radius:5px;color:#000;cursor:pointer;font-size:12px;font-weight:600">Apply</button>' +
        '</div>' +

        '<div style="margin-top:8px;font-size:10px;color:var(--faint);line-height:1.4">Values from AS/NZS 3008.1.1:2017 Table 4, copper multicore. Verify against current edition before use in design.</div>' +
      '</div>';

    document.body.appendChild(el);
    _dModal = el;

    document.getElementById("dModalClose").onclick = hideDerateModal;
    document.getElementById("dCancel").onclick     = hideDerateModal;
    document.getElementById("dApply").onclick      = function () { saveDerateSettings(false); };
    document.getElementById("dApplyAll").onclick   = function () { saveDerateSettings(true); };

    var liveIds = ["dMethodSel", "dBunchedSel", "dAmbInp"];
    liveIds.forEach(function (id) {
      var el2 = document.getElementById(id);
      el2.oninput = el2.onchange = updateDeratePreview;
    });
    el.querySelectorAll("input[name='dInsul']").forEach(function (r) { r.onchange = updateDeratePreview; });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _dModal && _dModal.style.display !== "none") hideDerateModal();
    });
  }

  function hideDerateModal() {
    if (_dModal) _dModal.style.display = "none";
    _dModalCid = null;
  }

  function openDerateModal(cid) {
    buildDerateModal();
    _dModalCid = cid;
    var circuit = (_appCircuit(cid));
    if (!circuit) return;

    var method  = circuit.derateMethod  || "insulation";
    var insul   = circuit.derateInsul   || "v90";
    if (insul === "xlpe") insul = "xlpe_90";
    var bunched = String(circuit.derateBunched || 1);
    var isUG    = (method === "ug_conduit" || method === "ug_direct");
    var ambTemp = circuit.derateAmbient != null ? circuit.derateAmbient : (isUG ? 25 : 40);

    document.getElementById("dModalName").textContent = circuit.name || "Circuit";
    document.getElementById("dMethodSel").value       = method;
    document.getElementById("dBunchedSel").value      = bunched;
    document.getElementById("dAmbInp").value          = ambTemp;
    _dModal.querySelectorAll("input[name='dInsul']").forEach(function (r) { r.checked = (r.value === insul); });

    updateDeratePreview();
    _dModal.style.display = "block";
  }

  function _appCircuit(cid) {
    var s = window._appState; if (!s) return null;
    return (s.circuits || []).find(function (c) { return c.id === cid; }) || null;
  }

  function updateDeratePreview() {
    if (!_dModal || !_dModalCid) return;
    var circuit = _appCircuit(_dModalCid); if (!circuit) return;

    var method  = document.getElementById("dMethodSel").value;
    var insulEl = _dModal.querySelector("input[name='dInsul']:checked");
    var insul   = insulEl ? insulEl.value : "v90";
    var bunched = parseInt(document.getElementById("dBunchedSel").value) || 1;
    var isUG    = (method === "ug_conduit" || method === "ug_direct");
    var ambTemp = parseFloat(document.getElementById("dAmbInp").value);
    if (isNaN(ambTemp)) ambTemp = isUG ? 25 : 40;

    document.getElementById("dAmbLabel").textContent = isUG ? "Ground temp" : "Ambient air temp";

    var Cg = getGroupFactor(bunched);
    var Ca = getAmbFactor(insul, method, ambTemp);
    document.getElementById("dCgVal").textContent = Cg.toFixed(2);
    document.getElementById("dCgVal").style.color = Cg < 0.9 ? "#f59e0b" : "var(--accent,#38bdf8)";
    document.getElementById("dCaVal").textContent = Ca.toFixed(2);
    document.getElementById("dCaVal").style.color = Ca < 0.9 ? "#f59e0b" : "var(--accent,#38bdf8)";

    var tmp = {};
    for (var k in circuit) tmp[k] = circuit[k];
    tmp.derateMethod = method; tmp.derateInsul = insul; tmp.derateBunched = bunched; tmp.derateAmbient = ambTemp;

    var result  = calcDerating(tmp);
    var sizeKey = parseCableSize(circuit.cableSize);
    var cbA     = parseCbRating(circuit.cbRating);
    var html;

    if (!result) {
      html = '<span style="color:var(--faint)">' + (sizeKey ? "Size " + sizeKey + "mm² not in table" : "Enter cable size to see result") + '</span>';
    } else {
      var ok    = cbA ? result.Iderated >= cbA : null;
      var color = ok === null ? "var(--text,#e7edf5)" : ok ? "#4ade80" : "#f87171";
      html = '<div style="font-family:var(--mono);font-size:11px;line-height:2">' +
        '<div>Base: <strong>' + result.Ibase + ' A</strong>&nbsp;&nbsp;(' + (METHOD_LABELS[method] || method) + ', ' + (INSUL_LABELS[insul] || insul) + ')</div>' +
        '<div>Derated: ' + result.Ibase + ' × ' + Cg.toFixed(2) + ' × ' + Ca.toFixed(2) + ' = <strong style="color:' + color + '">' + result.Iderated.toFixed(1) + ' A</strong></div>' +
        (cbA ? '<div style="color:' + color + '">' + (ok ? '✓ Adequate — ' + result.Iderated.toFixed(1) + 'A ≥ CB ' + cbA + 'A' : '✗ Undersized — ' + result.Iderated.toFixed(1) + 'A &lt; CB ' + cbA + 'A') + '</div>' : '') +
      '</div>';
    }
    document.getElementById("dResult").innerHTML = html;
  }

  function saveDerateSettings(applyAll) {
    if (!_dModal) return;
    var method  = document.getElementById("dMethodSel").value;
    var insulEl = _dModal.querySelector("input[name='dInsul']:checked");
    var insul   = insulEl ? insulEl.value : "v90";
    var bunched = parseInt(document.getElementById("dBunchedSel").value) || 1;
    var isUG    = (method === "ug_conduit" || method === "ug_direct");
    var ambTemp = parseFloat(document.getElementById("dAmbInp").value);
    if (isNaN(ambTemp)) ambTemp = isUG ? 25 : 40;

    var circuits = ((window._appState || {}).circuits || []);
    var targets  = applyAll ? circuits : circuits.filter(function (c) { return c.id === _dModalCid; });
    targets.forEach(function (c) {
      c.derateMethod  = method;
      c.derateInsul   = insul;
      c.derateBunched = bunched;
      c.derateAmbient = ambTemp;
    });
    hideDerateModal();
    if (window.renderCircuitsTable) window.renderCircuitsTable();
  }

  // ── Floating load monitor ─────────────────────────────────────────────

  var _monVisible = false;
  var _monEl = null;

  function buildMonitor() {
    if (_monEl) return;
    var el = document.createElement("div");
    el.id = "loadMonitor";
    el.style.cssText = [
      "position:fixed","bottom:80px","right:20px","z-index:500",
      "width:280px","background:var(--panel,#1a2030)","border:1px solid var(--border,#2d3748)",
      "border-radius:10px","box-shadow:0 4px 24px rgba(0,0,0,0.5)",
      "font-family:var(--sans,'IBM Plex Sans',sans-serif)","font-size:12px",
      "color:var(--text,#e7edf5)","overflow:hidden","display:none"
    ].join(";");
    el.innerHTML =
      '<div id="loadMonHdr" style="padding:8px 12px;background:var(--panel-2,#232d3f);display:flex;align-items:center;gap:8px;cursor:move;user-select:none;border-bottom:1px solid var(--border,#2d3748)">' +
        '<span style="font-size:13px">⚡</span>' +
        '<span style="flex:1;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8899aa)">Live Load — Active Layer</span>' +
        '<button id="loadMonClose" style="background:none;border:none;color:var(--muted,#8899aa);cursor:pointer;font-size:14px;padding:0 2px" title="Close">✕</button>' +
      '</div>' +
      '<div id="loadMonBody" style="padding:10px 12px;max-height:320px;overflow-y:auto"></div>';
    document.body.appendChild(el);
    _monEl = el;
    document.getElementById("loadMonClose").onclick = function () {
      _monVisible = false; _monEl.style.display = "none"; updateMonBtn();
    };
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
      _monEl.style.left = (e.clientX - dx) + "px"; _monEl.style.top = (e.clientY - dy) + "px";
      _monEl.style.bottom = "auto"; _monEl.style.right = "auto";
    });
    document.addEventListener("mouseup", function () { dragging = false; document.body.style.userSelect = ""; });
  }

  function updateMonBtn() {
    var btn = document.getElementById("loadMonBtn"); if (!btn) return;
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
    var state = window._appState; if (!state) return;
    var lid      = state.activeLayerId;
    var layer    = lid ? (state.layers || []).find(function (l) { return l.id === lid; }) : null;
    var circuits = state.circuits || [];
    var byCkt = {}, unassigned = [];
    ;(state.sheets || []).forEach(function (sh) {
      (sh.symbols || []).forEach(function (sym) {
        var symLid = sym.visibleLayerId;
        if (!symLid) { var tc = (state.symbolTypes && state.symbolTypes[sym.type]) || {}; symLid = tc.palLayerId || null; }
        if (symLid !== lid) return;
        var contrib = resolveContrib(sym);
        if (sym.circuitId) {
          if (!byCkt[sym.circuitId]) { var ckt = circuits.find(function (c) { return c.id === sym.circuitId; }); byCkt[sym.circuitId] = { circuit: ckt || { name: sym.circuitId, cbRating: "" }, syms: [], total: 0 }; }
          byCkt[sym.circuitId].syms.push({ sym: sym, contrib: contrib }); byCkt[sym.circuitId].total += contrib;
        } else { unassigned.push({ sym: sym, contrib: contrib }); }
      });
    });
    var layerName  = layer ? layer.name  : (lid ? lid : "None");
    var layerColor = layer ? layer.color : "var(--faint)";
    var html = '<div style="font-size:11px;color:' + layerColor + ';font-weight:600;margin-bottom:8px">● ' + escHtml(layerName) + '</div>';
    var cktIds = Object.keys(byCkt);
    if (!cktIds.length && !unassigned.length) html += '<div style="color:var(--faint);font-size:11px">No symbols on this layer yet.</div>';
    cktIds.forEach(function (cid) {
      var entry = byCkt[cid], c = entry.circuit;
      var cbA2 = parseCbRating(c.cbRating), total = entry.total;
      var pct2 = cbA2 ? (total / cbA2) * 100 : null;
      var over = pct2 !== null && pct2 > 100, warn = pct2 !== null && pct2 > 80 && !over;
      var barColor = over ? "#f87171" : warn ? "#f59e0b" : "#38bdf8";
      var barW = pct2 !== null ? Math.min(pct2, 100).toFixed(0) : 0;
      html += '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
          '<span style="font-weight:500;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(c.name) + '">' + escHtml(c.name) + '</span>' +
          '<span style="font-family:var(--mono);font-size:11px;color:' + barColor + '">' + total.toFixed(1) + 'A' + (cbA2 ? ' / ' + cbA2 + 'A' : '') + '</span>' +
        '</div>' +
        '<div style="background:var(--bg-alt,#111827);border-radius:3px;height:5px;overflow:hidden"><div style="height:100%;width:' + barW + '%;background:' + barColor + ';border-radius:3px;transition:width .3s"></div></div>' +
        '<div style="margin-top:4px;font-size:10px;color:var(--faint)">' + entry.syms.map(function (s) { return escHtml(s.sym.type.replace(/_/g," ")) + ' ' + s.contrib.toFixed(1) + 'A'; }).join(' · ') + '</div>' +
      '</div>';
    });
    if (unassigned.length) {
      var uTotal = unassigned.reduce(function (s, x) { return s + x.contrib; }, 0);
      html += '<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--faint);font-size:11px">Unassigned</span><span style="font-family:var(--mono);font-size:11px;color:var(--faint)">' + uTotal.toFixed(1) + 'A</span></div>' +
        '<div style="font-size:10px;color:var(--faint)">' + unassigned.map(function (s) { return escHtml(s.sym.type.replace(/_/g," ")) + ' ' + s.contrib.toFixed(1) + 'A'; }).join(' · ') + '</div>' +
      '</div>';
    }
    document.getElementById("loadMonBody").innerHTML = html;
  };

  function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // ── Print schedule ────────────────────────────────────────────────────
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
        var lengthM     = getCircuitLength(c.id);
        var lenStr      = lengthM ? lengthM.toFixed(1) + " m" : "—";
        var deviceTotal = getCircuitDeviceCurrent(c.id);
        var cbA2        = parseCbRating(c.cbRating);
        var useDevice   = c.useDeviceCurrent && deviceTotal != null;
        var Iload       = useDevice ? deviceTotal : (cbA2 ? cbA2 * 0.5 : null);
        var basisStr    = useDevice ? deviceTotal.toFixed(2) + " A (dev)" : (cbA2 ? (cbA2 * 0.5).toFixed(1) + " A (50%CB)" : "—");
        var vd          = calcVd(c, lengthM, Iload);
        var elfi        = calcElfi(c, lengthM);
        var dr          = calcDerating(c);
        var vdStr       = vd   ? vd.vdPct.toFixed(1)      + "%" : "—";
        var elfiStr     = elfi ? elfi.Zint.toFixed(2)      + " Ω" : "—";
        var lmaxStr     = elfi ? elfi.Lmax.toFixed(0)      + " m" : "—";
        var drStr       = dr   ? dr.Iderated.toFixed(1)    + " A" : "—";
        var speStr      = elfi ? "(" + elfi.Sph + "/" + elfi.Spe + "mm²)" : "";
        var vdOk        = vd   && vd.vdPct   <= VD_LIMIT;
        var elfiOk      = elfi && elfi.elfiPass;
        var lmaxOk      = elfi && (!lengthM || lengthM <= elfi.Lmax);
        var drOk        = dr && cbA2 ? dr.Iderated >= cbA2 : null;
        var drMethod    = dr ? (METHOD_LABELS[dr.method] || dr.method) + " / " + (INSUL_LABELS[dr.insul] || dr.insul) : "—";

        function cell(val, ok, center) {
          var st = center ? "text-align:center;" : "";
          if (ok === true)  st += "color:#166534;background:#dcfce7;border-radius:3px;padding:1px 4px;";
          if (ok === false) st += "color:#991b1b;background:#fee2e2;border-radius:3px;padding:1px 4px;";
          return '<td style="' + st + '">' + val + '</td>';
        }

        var bg = idx % 2 === 0 ? "#ffffff" : "#f4f6f9";
        var devLoadStr = deviceTotal != null ? deviceTotal.toFixed(1) + " A" : "—";
        var devLoadOk  = deviceTotal != null && cbA2 ? (deviceTotal <= cbA2 ? true : false) : null;
        return '<tr style="background:' + bg + '">'
          + '<td>' + (c.name || "—") + '</td>'
          + cell(c.cbRating  || "—", null,      true)
          + cell(devLoadStr,          devLoadOk, true)
          + cell(drStr,               drOk,      true)
          + cell(drMethod,            null,      false)
          + cell((c.cableSize || "—") + " " + speStr, null, true)
          + cell(c.cableCores || "—", null, true)
          + cell(c.cableType  || "—", null, true)
          + cell(lenStr,   null,   true)
          + cell(basisStr, null,   true)
          + cell(vdStr,    vd   ? vdOk   : null, true)
          + cell(elfiStr,  elfi ? elfiOk : null, true)
          + cell(lmaxStr,  elfi ? lmaxOk : null, true)
          + '</tr>';
      }).join("");

      var html =
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<title>Circuit Schedule — ' + projName + '</title>'
        + '<style>'
        + '* { box-sizing:border-box; margin:0; padding:0; }'
        + 'body { font-family:Arial,Helvetica,sans-serif; font-size:10px; color:#111; padding:15mm 12mm; }'
        + 'h1 { font-size:16px; margin-bottom:4px; }'
        + '.meta { color:#555; font-size:10px; margin-bottom:3px; }'
        + '.note { color:#555; font-size:9px; margin-bottom:14px; font-style:italic; }'
        + 'table { width:100%; border-collapse:collapse; margin-top:6px; }'
        + 'thead tr { background:#2a3340 !important; }'
        + 'th { color:#fff; padding:6px 6px; text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:0.4px; }'
        + 'th.c, td.c { text-align:center; }'
        + 'td { padding:5px 6px; border-bottom:1px solid #ddd; vertical-align:middle; }'
        + '.btn-print { display:inline-block; margin-bottom:14px; padding:7px 18px; background:#ffb02e; border:none; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; }'
        + '@media print { .no-print { display:none !important; } }'
        + '</style></head><body>'
        + '<div class="no-print" style="margin-bottom:14px"><button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button></div>'
        + '<h1>Circuit Schedule</h1>'
        + '<p class="meta">Project: <strong>' + projName + '</strong>&nbsp;&nbsp;|&nbsp;&nbsp;Date: ' + new Date().toLocaleDateString("en-AU") + '</p>'
        + '<p class="note">'
        + 'Cable I: derated ampacity per AS/NZS 3008.1.1:2017 Table 4, copper multicore (verify against current edition). '
        + 'VD%: AS/NZS 3008.1.1 Tbl 30, copper 75°C, limit 5% per AS/NZS 3000 cl 3.5.1. '
        + 'ELFI &amp; Lmax: AS/NZS 3000:2018 Appendix B cl B5.2.2, Type C MCB (Ia=7.5×In), Spe from Tbl 5.1.'
        + '</p>'
        + '<table><thead><tr>'
        + '<th>Circuit</th><th class="c">CB</th><th class="c">Dev load</th>'
        + '<th class="c">Cable I</th><th>Method / Insul</th>'
        + '<th class="c">Size (act/earth)</th><th class="c">Cores</th><th class="c">Type</th>'
        + '<th class="c">Length</th><th class="c">Load I</th>'
        + '<th class="c">VD%</th><th class="c">ELFI (Ω)</th><th class="c">Lmax (m)</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>'
        + '<script>setTimeout(function(){ window.print(); }, 500);<\/script>'
        + '</body></html>';

      var w = window.open("", "_blank");
      if (w) { w.document.write(html); w.document.close(); }
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  window.asCircuitCalc = {
    calcVd: calcVd, calcElfi: calcElfi, calcDerating: calcDerating,
    parseCableSize: parseCableSize, parseCbRating: parseCbRating,
    getSpe: getSpe, getCircuitDeviceCurrent: getCircuitDeviceCurrent,
    getGroupFactor: getGroupFactor, getAmbFactor: getAmbFactor,
    VD_TABLE: VD_TABLE, SPE_TABLE: SPE_TABLE, DERATE: DERATE,
    VD_LIMIT: VD_LIMIT, RHO_CU: RHO_CU, UO: UO, IA_FACTOR_C: IA_FACTOR_C
  };

  var _attempts = 0;
  function tryPatch() {
    _attempts++;
    if (patchRenderCircuitsTable()) {
      if (!window.getAppState) window.getAppState = function () { return window._appState || null; };
      patchPrintSchedule();
      if (typeof window.renderCircuitsTable === "function") window.renderCircuitsTable();
    } else if (_attempts < 30) {
      setTimeout(tryPatch, 200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(tryPatch, 900); });
  } else {
    setTimeout(tryPatch, 900);
  }

})();
