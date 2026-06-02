/* =====================================================================
 *  Plan Estimator -- front-end application (multi-sheet model)
 *  Depends on: Konva (canvas), pdf.js (PDF rasterising), symbols.js
 *
 *  DATA MODEL
 *    project
 *      .layers[]        project-wide cable/run layers  {id,name,color,visible,part}
 *      .symbolTypes{}   per symbol type  type -> {part, dropM, dropLayerId}
 *      .wastagePct      global cable wastage %
 *      .sheets[]        {id,name,planImage,imgW,imgH,scale,lines[],symbols[]}
 *                       scale = {p1,p2,realMeters}  (per-sheet calibration)
 *                       lines = {id,layerId,points[],lengthM}
 *                       symbols = {id,type,x,y}
 *      .activeSheetId / .activeLayerId
 * ===================================================================== */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var LIB = window.SYMBOL_LIB;
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.__PDF_WORKER__ ||
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  var LAYER_COLORS = ["#ffb02e", "#38bdf8", "#34d399", "#f87171", "#c084fc",
                      "#fb923c", "#facc15", "#22d3ee", "#a3e635", "#f472b6"];
  var uid = function (p) { return (p || "id") + "_" + Math.random().toString(36).slice(2, 9); };
  var state = null;

  // ------------- undo / redo -------------
  var _undoStack = [], _redoStack = [];
  var _MAX_HISTORY = 50;
  function snapshotState() {
    // Deep-clone only the sheet/layer data (not canvas nodes)
    try { return JSON.parse(JSON.stringify({
      layers: state.layers, symbolTypes: state.symbolTypes,
      sheets: state.sheets, activeSheetId: state.activeSheetId,
      activeLayerId: state.activeLayerId, wastagePct: state.wastagePct,
      labourRate: state.labourRate, manualTakeoff: state.manualTakeoff || [],
      customSymbols: state.customSymbols || [], customParts: state.customParts || [],
      circuits: state.circuits || [],
      labelScale: state.labelScale, labelColor: state.labelColor
    })); } catch(e) { return null; }
  }
  function pushUndo() {
    var snap = snapshotState(); if (!snap) return;
    _undoStack.push(snap);
    if (_undoStack.length > _MAX_HISTORY) _undoStack.shift();
    _redoStack = [];   // new action clears redo branch
    updateUndoButtons();
  }
  function restoreSnapshot(snap) {
    state.layers      = snap.layers;
    state.symbolTypes = snap.symbolTypes;
    state.sheets      = snap.sheets;
    state.activeSheetId  = snap.activeSheetId;
    state.activeLayerId  = snap.activeLayerId;
    state.wastagePct     = snap.wastagePct;
    state.labourRate     = snap.labourRate;
    state.manualTakeoff  = snap.manualTakeoff  || [];
    state.customSymbols  = snap.customSymbols  || [];
    state.customParts    = snap.customParts    || [];
    state.circuits       = snap.circuits       || [];
    state.labelScale     = snap.labelScale     != null ? snap.labelScale : 0.4;
    state.labelColor     = snap.labelColor     || "#e7edf5";
    window._appState = state;
    symbolImages = {};
    preloadSymbols();
    renderPalette(); renderSheets(); renderLayers(); renderActiveSheet(); refreshTakeoff();
    if (window.renderCircuitsTable) window.renderCircuitsTable();
  }
  function undoAction() {
    if (!_undoStack.length) return;
    var current = snapshotState(); if (current) _redoStack.push(current);
    restoreSnapshot(_undoStack.pop());
    updateUndoButtons();
    toast("Undo");
  }
  function redoAction() {
    if (!_redoStack.length) return;
    var current = snapshotState(); if (current) _undoStack.push(current);
    restoreSnapshot(_redoStack.pop());
    updateUndoButtons();
    toast("Redo");
  }
  function updateUndoButtons() {
    var bu = document.getElementById("btnUndo"), br = document.getElementById("btnRedo");
    if (bu) bu.disabled = !_undoStack.length;
    if (br) br.disabled = !_redoStack.length;
  }

  function newState() {
    return { name: "", wastagePct: 10, labourRate: 85, layers: [], symbolTypes: {},
             customSymbols: [], customParts: [], circuits: [],
             labelScale: 0.4, labelColor: "#e7edf5",
             quoteInfo: { business: "", details: "", client: "", quoteNo: "", taxRate: 10, prices: "retail", notes: "Prices valid for 30 days. E&OE." },
             sheets: [], activeSheetId: null, activeLayerId: null };
  }
  function sheet() { return state.sheets.find(function (s) { return s.id === state.activeSheetId; }) || null; }
  function layerById(id) { return state.layers.find(function (l) { return l.id === id; }); }

  // ---- symbol resolution (built-in + custom) ----
  function customSymbol(type) { return ((state && state.customSymbols) || []).find(function (s) { return s.id === type; }); }
  function symInfo(type) { return LIB.byId[type] || customSymbol(type) || { name: type, category: "custom" }; }
  function symImageURL(type) { var c = customSymbol(type); return c ? c.dataURL : LIB.symbolDataURL(type); }
  function allSymbols() { return LIB.list.concat((state && state.customSymbols) || []); }
  // Build a labelled marker SVG for custom symbols with no uploaded image.
  function buildLabelSymbol(name, category) {
    var accent = LIB.categoryColors[category] || "#ffb02e";
    var label = (name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">' +
      '<rect x="2" y="2" width="40" height="40" rx="9" fill="#10151d" fill-opacity="0.9" stroke="' + accent + '" stroke-width="2.5"/>' +
      '<text x="22" y="22" fill="#f0f4f8" font-family="IBM Plex Sans, sans-serif" font-size="13" font-weight="700" ' +
      'text-anchor="middle" dominant-baseline="central">' + label + "</text></svg>";
    return "data:image/svg+xml;base64," + btoa(svg);
  }
  function ensureSymbolImage(type) {
    if (symbolImages[type]) return symbolImages[type];
    var img = new Image();
    img.onload = function () { shapeLayer && shapeLayer.batchDraw(); };
    img.src = symImageURL(type);
    symbolImages[type] = img;
    return img;
  }

  // ------------- Konva -------------
  var stage, bgLayer, shapeLayer, calLayer, planNode = null, transformer = null;
  var symbolImages = {}, lineNodes = {}, symbolNodes = {}, refLabelNodes = {}, routeNodes = {}, textNodes = {}, calNodes = null;
  var tool = "select", activeSymbolType = null, selected = null, newSymbolSize = 30;
  var draftPoints = null, draftPreview = null, spaceDown = false;

  function initStage() {
    var wrap = $("canvas-wrap");
    stage = new Konva.Stage({ container: "stage", width: wrap.clientWidth, height: wrap.clientHeight });
    bgLayer = new Konva.Layer(); shapeLayer = new Konva.Layer(); calLayer = new Konva.Layer();
    stage.add(bgLayer, shapeLayer, calLayer);
    stage.on("wheel", onWheel);
    stage.on("mousedown touchstart", onStageDown);
    stage.on("mousemove", onStageMove);
    stage.on("dblclick dbltap", onStageDblClick);
    stage.on("contextmenu", onStageContextMenu);
    window.addEventListener("resize", function () {
      stage.width(wrap.clientWidth); stage.height(wrap.clientHeight);
    });
  }
  function addTransformer() {
    transformer = new Konva.Transformer({
      rotateEnabled: true, keepRatio: true,
      enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
      anchorSize: 9, anchorStroke: "#ffb02e", anchorFill: "#1a130a", borderStroke: "#ffb02e",
      ignoreStroke: true, padding: 4,
    });
    shapeLayer.add(transformer);
  }
  function preloadSymbols() {
    LIB.list.forEach(function (s) { ensureSymbolImage(s.id); });
    ((state && state.customSymbols) || []).forEach(function (s) { ensureSymbolImage(s.id); });
  }

  // ------------- geometry / scale -------------
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function polyLengthPx(p) { var L = 0; for (var i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; }
  function mppOf(sh) {
    if (!sh || !sh.scale || sh.scale.realMeters == null) return null;
    var d = dist(sh.scale.p1, sh.scale.p2); return d ? sh.scale.realMeters / d : null;
  }
  function fmtM(m) { return (m == null) ? "—" : m.toFixed(2) + " m"; }
  function fmt$(v) { return "$" + (v || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pointAtHalf(pts) {
    var total = polyLengthPx(pts), acc = 0;
    for (var i = 2; i < pts.length; i += 2) {
      var seg = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      if (acc + seg >= total / 2) {
        var t = seg ? (total / 2 - acc) / seg : 0;
        return { x: pts[i - 2] + (pts[i] - pts[i - 2]) * t, y: pts[i - 1] + (pts[i + 1] - pts[i - 1]) * t };
      }
      acc += seg;
    }
    return { x: pts[0], y: pts[1] };
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // ------------- sheets: file loading -------------
  function handleFile(file) {
    if (!file) return;
    if (file.type === "application/pdf") {
      if (!window.pdfjsLib) { toast("pdf.js failed to load (no internet?)", true); return; }
      var fr = new FileReader();
      fr.onload = function () { loadPdf(new Uint8Array(fr.result), file.name); };
      fr.readAsArrayBuffer(file);
    } else if (/^image\//.test(file.type)) {
      var r = new FileReader();
      r.onload = function () { createSheet(r.result, file.name.replace(/\.[^.]+$/, "")); };
      r.readAsDataURL(file);
    } else { toast("Unsupported file type", true); }
  }
  function loadPdf(bytes, fname) {
    pdfjsLib.getDocument({ data: bytes }).promise.then(function (doc) {
      var base = (fname || "Sheet").replace(/\.[^.]+$/, "");
      if (doc.numPages > 1 &&
          confirm("This PDF has " + doc.numPages + " pages. Import ALL pages as separate sheets?\n\nOK = all pages, Cancel = just page 1")) {
        var startIdx = state.sheets.length;
        var chain = Promise.resolve();
        for (var i = 1; i <= doc.numPages; i++) {
          (function (pg) {
            chain = chain.then(function () {
              return renderPdfPage(doc, pg).then(function (url) {
                return createSheet(url, base + " p" + pg, true);
              });
            });
          })(i);
        }
        chain.then(function () {
          if (state.sheets[startIdx]) state.activeSheetId = state.sheets[startIdx].id;
          renderSheets(); renderActiveSheet(); refreshTakeoff();
          toast(doc.numPages + " sheets imported");
        });
      } else {
        renderPdfPage(doc, 1).then(function (url) { createSheet(url, base); });
      }
    }).catch(function (e) { toast("PDF error: " + e.message, true); });
  }
  function renderPdfPage(doc, pageNum) {
    return doc.getPage(pageNum).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var s = Math.min(3, 2000 / Math.max(base.width, base.height));
      var vp = page.getViewport({ scale: s });
      var c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      return page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise
        .then(function () { return c.toDataURL("image/png"); });
    });
  }
  function createSheet(dataURL, name, batch) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var sh = { id: uid("sheet"), name: name || ("Sheet " + (state.sheets.length + 1)),
          planImage: dataURL, imgW: img.naturalWidth, imgH: img.naturalHeight,
          scale: null, lines: [], symbols: [], routes: [], texts: [] };
        state.sheets.push(sh);
        state.activeSheetId = sh.id;
        if (!batch) { renderSheets(); renderActiveSheet(); refreshTakeoff(); }
        resolve(sh);
      };
      img.onerror = function () { toast("Could not load image", true); resolve(null); };
      img.src = dataURL;
    });
  }

  // ------------- render active sheet onto canvas -------------
  function renderActiveSheet() {
    bgLayer.destroyChildren(); shapeLayer.destroyChildren(); calLayer.destroyChildren();
    lineNodes = {}; symbolNodes = {}; refLabelNodes = {}; routeNodes = {}; textNodes = {}; calNodes = null; planNode = null;
    selected = null; cancelDraft();
    addTransformer();
    var sh = sheet();
    $("emptyState").style.display = sh ? "none" : "flex";
    if (!sh) { bgLayer.draw(); shapeLayer.draw(); calLayer.draw(); updateScaleStatus(); return; }
    var img = new Image();
    img.onload = function () {
      planNode = new Konva.Image({ image: img, x: 0, y: 0, width: sh.imgW, height: sh.imgH, listening: false });
      bgLayer.add(planNode); bgLayer.batchDraw(); fitView();
    };
    img.src = sh.planImage;
    // Render lines and routes FIRST so symbols sit on top of them in z-order.
    // This ensures symbols are always clickable/right-clickable even when a
    // circuit line passes through the same point.
    sh.lines.forEach(function (l) { recalcLine(l); renderLine(l); });
    (sh.routes || []).forEach(renderRoute);
    (sh.texts  || []).forEach(renderText);
    sh.symbols.forEach(renderSymbol);
    // Apply layer visibility
    sh.symbols.forEach(function (s) {
      if (s.visibleLayerId) {
        var lay = layerById(s.visibleLayerId);
        if (lay && lay.visible === false && symbolNodes[s.id]) symbolNodes[s.id].visible(false);
      }
    });
    // Ensure unassigned symbols sit above all lines/routes
    liftUnassignedSymbols();
    renderCalibration();
    setTool(tool);
    updateScaleStatus();
  }

  // ------------- view -------------
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function onWheel(e) {
    e.evt.preventDefault(); if (!planNode) return;
    var old = stage.scaleX(), ptr = stage.getPointerPosition();
    var to = { x: (ptr.x - stage.x()) / old, y: (ptr.y - stage.y()) / old };
    var ns = clamp(e.evt.deltaY > 0 ? old / 1.12 : old * 1.12, 0.03, 30);
    stage.scale({ x: ns, y: ns });
    stage.position({ x: ptr.x - to.x * ns, y: ptr.y - to.y * ns });
    stage.batchDraw(); updateZoomLabel(); restrokeForZoom();
  }
  function zoomBy(f) {
    var old = stage.scaleX(), c = { x: stage.width() / 2, y: stage.height() / 2 };
    var to = { x: (c.x - stage.x()) / old, y: (c.y - stage.y()) / old };
    var ns = clamp(old * f, 0.03, 30);
    stage.scale({ x: ns, y: ns });
    stage.position({ x: c.x - to.x * ns, y: c.y - to.y * ns });
    stage.batchDraw(); updateZoomLabel(); restrokeForZoom();
  }
  function fitView() {
    var sh = sheet(); if (!sh) return;
    var pad = 40, s = Math.min((stage.width() - pad * 2) / sh.imgW, (stage.height() - pad * 2) / sh.imgH);
    stage.scale({ x: s, y: s });
    stage.position({ x: (stage.width() - sh.imgW * s) / 2, y: (stage.height() - sh.imgH * s) / 2 });
    stage.batchDraw(); updateZoomLabel(); restrokeForZoom();
  }
  function updateZoomLabel() { $("stZoom").textContent = Math.round(stage.scaleX() * 100) + "%"; }
  // keep strokes/handles a constant screen size as zoom changes
  function restrokeForZoom() {
    var k = 1 / stage.scaleX();
    Object.values(lineNodes).forEach(function (n) { n.line.strokeWidth((selected && selected.id === n.line._lineId ? 5.4 : 3) * k); });
    Object.values(routeNodes).forEach(function (n) { if (n._useWorldWidth) return; n.strokeWidth((selected && selected.id === n._routeId ? 4 : 2) * k); });
    if (calNodes) {
      calNodes.line.strokeWidth(2 * k); calNodes.line.dash([10 * k, 6 * k]);
      calNodes.h1.radius(7 * k); calNodes.h2.radius(7 * k);
      calNodes.h1.strokeWidth(1.5 * k); calNodes.h2.strokeWidth(1.5 * k);
    }
    shapeLayer.batchDraw(); calLayer.batchDraw();
  }

  // ------------- tools -------------
  function setTool(t) {
    tool = t; cancelDraft(); clearMeasure();
    document.querySelectorAll(".tool").forEach(function (b) { b.classList.toggle("active", b.dataset.tool === t); });
    $("stTool").textContent = {
      select: "Select", calibrate: "Calibrate", symbol: "Place Symbol",
      line: "Circuit", route: "Cable Route", text: "Add Text", measure: "Measure"
    }[t] || t;
    var drag = (t === "select");
    stage.draggable(drag);
    Object.values(symbolNodes).forEach(function (n) { n.draggable(drag); });
    Object.values(textNodes).forEach(function (n) { n.draggable(drag); });
    stage.container().style.cursor = t === "select" ? "default" : (t === "symbol" ? "copy" : "crosshair");
    showTip(t); if (t !== "select") deselect();
  }
  function showTip(t) {
    var tip = $("tip"), m = "";
    if (t === "calibrate") m = "Click two points on a known dimension to set this sheet's scale";
    else if (t === "symbol")  m = activeSymbolType ? "Click to place: " + symInfo(activeSymbolType).name : "Pick a symbol from the palette, then click the plan";
    else if (t === "line")    m = "Circuit: click to add points · Double-click / Enter to finish · Esc to cancel";
    else if (t === "route")   m = "Cable route: click to add points · Double-click / Enter to finish · Esc to cancel";
    else if (t === "text")    m = "Click anywhere on the plan to place a text label";
    else if (t === "measure") m = "Click start point, then end point — shows distance, does not save to plan";
    tip.style.display = m ? "block" : "none"; if (m) tip.textContent = m;
  }
  function worldPos() { return stage.getRelativePointerPosition(); }

  function onStageDown(e) {
    if (!planNode || spaceDown) return;
    var p = worldPos(); var sh = sheet();
    if (tool === "calibrate") {
      if (!draftPoints) draftPoints = [p.x, p.y];
      else {
        sh.scale = { p1: { x: draftPoints[0], y: draftPoints[1] }, p2: { x: p.x, y: p.y },
                     realMeters: sh.scale ? sh.scale.realMeters : null };
        draftPoints = null; cancelDraft(); renderCalibration(); openScaleModal();
      }
    } else if (tool === "measure") {
      if (!draftPoints) {
        draftPoints = [p.x, p.y];
        showTipText("Click end point to measure distance");
      } else {
        var mpp0 = mppOf(sheet());
        var pts0 = [draftPoints[0], draftPoints[1], p.x, p.y];
        var px0 = polyLengthPx(pts0);
        var msg = mpp0 ? (px0 * mpp0).toFixed(3) + " m  (" + (px0 * mpp0 * 1000).toFixed(0) + " mm)" : px0.toFixed(0) + " px (no scale set)";
        updateDraftPreview(null);
        showTipText("📏 " + msg + "  ·  click to measure again  ·  Esc to exit");
        draftPoints = null;
      }
    } else if (tool === "symbol") {
      if (!activeSymbolType) { toast("Select a symbol first", true); return; }
      addSymbol(activeSymbolType, p.x, p.y);
    } else if (tool === "line") {
      if (!state.activeLayerId) { toast("Create / select a layer first", true); return; }
      if (!draftPoints) draftPoints = [p.x, p.y]; else draftPoints.push(p.x, p.y);
      updateDraftPreview(p);
    } else if (tool === "route") {
      if (!state.activeLayerId) { toast("Create / select a layer first", true); return; }
      if (!draftPoints) draftPoints = [p.x, p.y]; else draftPoints.push(p.x, p.y);
      updateDraftPreview(p);
    } else if (tool === "text") {
      if (!state.activeLayerId) { toast("Create / select a layer first", true); return; }
      showTextInput(p.x, p.y);
    } else if (tool === "select") {
      if (e.target === stage || e.target === planNode) deselect();
    }
  }
  function onStageMove() {
    if (!planNode) return;
    var p = worldPos(), mpp = mppOf(sheet());
    $("stCursor").textContent = mpp ? (p.x * mpp).toFixed(2) + ", " + (p.y * mpp).toFixed(2) + " m"
      : Math.round(p.x) + ", " + Math.round(p.y) + " px";
    if (draftPoints && (tool === "line" || tool === "route" || tool === "calibrate" || tool === "measure")) updateDraftPreview(p);
  }
  function onStageDblClick() {
    if ((tool === "line" || tool === "route") && draftPoints) finishCurrent();
  }

  // ------------- right-click context menu -------------
  var ctxMenu = null;
  function removeCtxMenu() {
    if (ctxMenu && ctxMenu.parentNode) ctxMenu.parentNode.removeChild(ctxMenu);
    ctxMenu = null;
  }
  function onStageContextMenu(e) {
    e.evt.preventDefault();
    removeCtxMenu();

    // Use getAllIntersections so we can prioritise symbols over lines/routes
    // that may be drawn on top in the same layer.
    var pos = stage.getPointerPosition();
    var hits = stage.getAllIntersections(pos);

    // Priority order: symbol > textAnnot > line > route
    var symId   = null, lineId  = null, routeId = null, textId  = null;
    hits.forEach(function (node) {
      if (node._symId   && !symId)   symId   = node._symId;
      if (node._textId  && !textId)  textId  = node._textId;
      if (node._lineId  && !lineId)  lineId  = node._lineId;
      if (node._routeId && !routeId) routeId = node._routeId;
    });
    // Apply priority — if a symbol was hit, ignore lines/routes beneath
    if (symId)  { lineId = null; routeId = null; textId = null; }
    else if (textId) { lineId = null; routeId = null; }

    // Nothing actionable hit
    if (!symId && !lineId && !routeId && !textId) return;

    var sh = sheet();
    var items = [];

    if (symId) {
      var s = sh && sh.symbols.find(function (x) { return x.id === symId; });
      items.push({ label: "✏️  Edit properties", action: function () {
        if (tool !== "select") setTool("select");
        select("symbol", symId);
        if (window.switchTab) window.switchTab("properties");
        if (s) { window._appSelectedSym = s; if (window.renderPropertiesPanel) window.renderPropertiesPanel(s); }
      }});
      items.push({ label: "🗑  Delete", danger: true, action: function () {
        if (tool !== "select") setTool("select");
        select("symbol", symId);
        deleteSelected();
      }});
    } else if (lineId) {
      items.push({ label: "✏️  Select circuit", action: function () {
        if (tool !== "select") setTool("select");
        select("line", lineId);
      }});
      items.push({ label: "🗑  Delete circuit", danger: true, action: function () {
        if (tool !== "select") setTool("select");
        select("line", lineId);
        deleteSelected();
      }});
    } else if (routeId) {
      items.push({ label: "✏️  Edit route properties", action: function () {
        if (tool !== "select") setTool("select");
        select("route", routeId);
      }});
      items.push({ label: "🗑  Delete route", danger: true, action: function () {
        if (tool !== "select") setTool("select");
        select("route", routeId);
        deleteSelected();
      }});
    } else if (textId) {
      items.push({ label: "✏️  Edit text", action: function () {
        if (tool !== "select") setTool("select");
        select("textAnnot", textId);
        var tn = textNodes[textId];
        if (tn) tn.fire("dblclick");
      }});
      items.push({ label: "🗑  Delete text", danger: true, action: function () {
        if (tool !== "select") setTool("select");
        select("textAnnot", textId);
        deleteSelected();
      }});
    }

    if (!items.length) return;

    // Build the menu
    var ptr = e.evt;
    var mx = ptr.clientX, my = ptr.clientY;
    var menu = document.createElement("div");
    menu.style.cssText =
      "position:fixed;left:" + mx + "px;top:" + my + "px;" +
      "background:#1c232f;border:1px solid #2e3a4a;border-radius:8px;" +
      "box-shadow:0 6px 24px rgba(0,0,0,0.6);z-index:9999;min-width:180px;padding:4px 0;font-family:'IBM Plex Sans',sans-serif;";
    items.forEach(function (item) {
      var el = document.createElement("div");
      el.style.cssText =
        "padding:8px 14px;cursor:pointer;font-size:13px;" +
        "color:" + (item.danger ? "#f87171" : "#e7edf5") + ";user-select:none;";
      el.textContent = item.label;
      el.onmouseenter = function () { el.style.background = "#2a3547"; };
      el.onmouseleave = function () { el.style.background = ""; };
      el.onclick = function () { removeCtxMenu(); item.action(); };
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    ctxMenu = menu;

    // Adjust if it would overflow
    requestAnimationFrame(function () {
      var r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (mx - r.width)  + "px";
      if (r.bottom > window.innerHeight) menu.style.top  = (my - r.height) + "px";
    });

    // Close on any outside click
    setTimeout(function () {
      document.addEventListener("mousedown", function closeCtx(ev) {
        if (!menu.contains(ev.target)) { removeCtxMenu(); document.removeEventListener("mousedown", closeCtx); }
      });
    }, 0);
  }

  // Also expose renderPropertiesPanel at the top scope for the context menu
  // (it's defined in the second IIFE and set on window, so this will work)

  function updateDraftPreview(cursor) {
    if (!draftPoints) return;
    var pts = draftPoints.slice(); if (cursor) pts.push(cursor.x, cursor.y);
    var k = 1 / stage.scaleX();
    var strokeColor = tool === "calibrate" ? "#ffb02e"
                    : tool === "measure"   ? "#34d399"
                    : tool === "route"     ? activeLayerColor()
                    : activeLayerColor();
    var isDashed = false;
    if (!draftPreview) {
      draftPreview = new Konva.Line({ points: pts, stroke: strokeColor,
        strokeWidth: 2 * k, dash: isDashed ? [10 * k, 5 * k] : [8 * k, 6 * k],
        lineCap: "round", lineJoin: "round", listening: false });
      calLayer.add(draftPreview);
    } else {
      draftPreview.points(pts);
      draftPreview.stroke(strokeColor);
      draftPreview.strokeWidth(2 * k);
      draftPreview.dash(isDashed ? [10 * k, 5 * k] : [8 * k, 6 * k]);
    }
    var mpp = mppOf(sheet());
    if (mpp && tool === "line")    showTipText("Total: " + (polyLengthPx(pts) * mpp).toFixed(2) + " m  ·  double-click / Enter to finish");
    if (mpp && tool === "measure") showTipText("📏 " + (polyLengthPx(pts) * mpp).toFixed(3) + " m  (" + (polyLengthPx(pts) * mpp * 1000).toFixed(0) + " mm)  ·  click to confirm");
    if (tool === "route") showTipText("Cable route ·  double-click / Enter to finish");
    calLayer.batchDraw();
  }
  function showTipText(t) { var tip = $("tip"); tip.textContent = t; tip.style.display = "block"; }
  function cancelDraft() { draftPoints = null; if (draftPreview) { draftPreview.destroy(); draftPreview = null; calLayer.batchDraw(); } }
  function clearMeasure() { cancelDraft(); showTip(tool); }
  function activeLayerColor() { var l = layerById(state.activeLayerId); return l ? l.color : "#ffb02e"; }

  // ------------- symbols -------------
  function addSymbol(type, x, y) {
    pushUndo();
    var s = { id: uid("sym"), type: type, x: x, y: y, size: newSymbolSize, rotation: 0,
              visibleLayerId: state.activeLayerId || null };
    sheet().symbols.push(s); renderSymbol(s); refreshTakeoff();

    // Seed defaultCurrentA into symbolTypes for this type if not already set.
    // Matches the symbol's display name against AS/NZS 3000 Table C9 defaults.
    if (!state.symbolTypes) state.symbolTypes = {};
    if (!state.symbolTypes[type]) state.symbolTypes[type] = {};
    if (state.symbolTypes[type].defaultCurrentA == null) {
      var lib = (window.SYMBOL_LIB && window.SYMBOL_LIB.defaultCurrentByType) || {};
      var info = symInfo(type);
      var nameKey = (info.name || type).toLowerCase().replace(/[\s\-\/\\().]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
      // Try progressively shorter prefix matches so "double_gpo_weatherproof" hits "double_gpo"
      var defaultA = null;
      var keys = Object.keys(lib);
      // Exact match first
      if (lib[nameKey] != null) {
        defaultA = lib[nameKey];
      } else {
        // Find longest key that the nameKey starts with
        var best = "";
        keys.forEach(function (k) {
          if (nameKey.indexOf(k) !== -1 && k.length > best.length) best = k;
        });
        if (best) defaultA = lib[best];
      }
      if (defaultA != null) state.symbolTypes[type].defaultCurrentA = defaultA;
    }
  }
  // Helper: compute label font size from symbol size using the global labelScale
  function refLabelFontSize(s) {
    var base = s.size || 30;
    var scale = (state && state.labelScale != null) ? state.labelScale : 0.4;
    return Math.max(6, Math.round(base * scale));
  }
  // Helper: position the label node relative to the symbol node
  function positionRefLabel(labelNode, symNode, s) {
    var size = s.size || 30;
    var fs   = refLabelFontSize(s);
    // Place label centred below the symbol (offset by half icon + small gap)
    var gap = Math.max(2, size * 0.12);
    labelNode.x(symNode.x());
    labelNode.y(symNode.y() + size / 2 + gap);
    labelNode.fontSize(fs);
    labelNode.offsetX(labelNode.width() / 2);  // re-centre after font change
  }
  function syncRefLabel(s) {
    var labelNode = refLabelNodes[s.id];
    var symNode   = symbolNodes[s.id];
    if (!labelNode || !symNode) return;
    var text = s.refNo || "";
    labelNode.text(text);
    labelNode.fill((state && state.labelColor) ? state.labelColor : "#e7edf5");
    // Respect layer visibility: if the symbol's layer is hidden, keep label hidden
    var layerVisible = true;
    if (s.visibleLayerId) {
      var lay = layerById(s.visibleLayerId);
      if (lay && lay.visible === false) layerVisible = false;
    }
    labelNode.visible(text.length > 0 && layerVisible);
    positionRefLabel(labelNode, symNode, s);
    labelNode.offsetX(labelNode.width() / 2);
    if (shapeLayer) shapeLayer.batchDraw();
  }

  // Re-sync all visible ref labels (called when global scale/color changes)
  function syncAllRefLabels() {
    var sh = sheet(); if (!sh) return;
    sh.symbols.forEach(function (s) { syncRefLabel(s); });
  }

  function renderSymbol(s) {
    var size = s.size || 30;
    ensureSymbolImage(s.type);
    var node = new Konva.Image({ image: symbolImages[s.type], x: s.x, y: s.y, width: size, height: size,
      offsetX: size / 2, offsetY: size / 2, rotation: s.rotation || 0, draggable: tool === "select" });
    node._symId = s.id;

    // Ref label — sits below the icon, not rotated, always horizontal
    var fs = refLabelFontSize(s);
    var _labelLayVisible = true;
    if (s.visibleLayerId) { var _ll = layerById(s.visibleLayerId); if (_ll && _ll.visible === false) _labelLayVisible = false; }
    var labelNode = new Konva.Text({
      x: s.x, y: s.y + size / 2 + Math.max(2, size * 0.12),
      text: s.refNo || "",
      fontSize: fs,
      fill: (state && state.labelColor) ? state.labelColor : "#e7edf5",
      fontFamily: "IBM Plex Sans, sans-serif",
      fontStyle: "bold",
      listening: false,   // clicks go through to the symbol beneath
      visible: !!(s.refNo) && _labelLayVisible,
      shadowColor: "#000", shadowBlur: 3, shadowOpacity: 0.7, shadowOffset: { x: 1, y: 1 }
    });
    // Centre horizontally
    labelNode.offsetX(labelNode.width() / 2);
    labelNode._symRefLabel = s.id;
    refLabelNodes[s.id] = labelNode;

    node.on("dragend", function () {
      s.x = node.x(); s.y = node.y();
      // Move label with symbol
      labelNode.x(s.x);
      positionRefLabel(labelNode, node, s);
      labelNode.offsetX(labelNode.width() / 2);
      shapeLayer.batchDraw();
      pushUndo();
    });
    node.on("transformend", function () {
      pushUndo();
      var ns = Math.max(8, node.width() * node.scaleX());
      node.scaleX(1); node.scaleY(1); node.width(ns); node.height(ns);
      node.offsetX(ns / 2); node.offsetY(ns / 2);
      s.size = ns; s.rotation = node.rotation(); s.x = node.x(); s.y = node.y();
      positionRefLabel(labelNode, node, s);
      labelNode.offsetX(labelNode.width() / 2);
      shapeLayer.batchDraw();
    });
    node.on("click tap", function (e) { if (tool === "select") { e.cancelBubble = true; select("symbol", s.id); } });

    node.on("mouseenter", function () {
      // Don't override the selected-state amber glow
      if (selected && selected.kind === "symbol" && selected.id === s.id) return;
      stage.container().style.cursor = tool === "select" ? "pointer" : "";
      node.shadowColor("#ffffff");
      node.shadowBlur(18);
      node.shadowOpacity(0.55);
      node.scaleX(1.08); node.scaleY(1.08);
      shapeLayer.batchDraw();
    });

    node.on("mouseleave", function () {
      if (selected && selected.kind === "symbol" && selected.id === s.id) return;
      stage.container().style.cursor = tool === "select" ? "default" : "";
      node.shadowBlur(0);
      node.scaleX(1); node.scaleY(1);
      shapeLayer.batchDraw();
    });

    symbolNodes[s.id] = node;
    shapeLayer.add(labelNode);
    shapeLayer.add(node);
    // Always keep symbols (and their labels) above lines/routes
    node.moveToTop();
    if (transformer) transformer.moveToTop();
    shapeLayer.batchDraw();
  }

  // Lift symbols that have no layer assignment above all lines/routes so they
  // remain clickable after new circuit lines are drawn on top.
  function liftUnassignedSymbols() {
    var sh = sheet(); if (!sh) return;
    sh.symbols.forEach(function (s) {
      if (!s.visibleLayerId) {
        var n = symbolNodes[s.id]; if (n) n.moveToTop();
        var rl = refLabelNodes[s.id]; if (rl) rl.moveToTop();
      }
    });
    if (transformer) transformer.moveToTop();
  }
  window.liftUnassignedSymbols = liftUnassignedSymbols;
  function resizeSelectedSymbol(size) {
    if (!selected || selected.kind !== "symbol") return;
    var node = symbolNodes[selected.id], sh = sheet();
    var s = sh.symbols.find(function (x) { return x.id === selected.id; });
    if (!node || !s) return;
    s.size = size; node.width(size); node.height(size); node.offsetX(size / 2); node.offsetY(size / 2);
    syncRefLabel(s);
    shapeLayer.batchDraw();
  }

  // ------------- circuits (lines) -------------
  function finishCurrent() {
    if (!draftPoints || draftPoints.length < 4) { cancelDraft(); return; }
    if (tool === "line") finishCircuit();
    else if (tool === "route") finishRoute();
  }
  function finishLine() { finishCircuit(); } // keep old name for any references

  function finishCircuit() {
    if (!draftPoints || draftPoints.length < 4) { cancelDraft(); return; }
    pushUndo();
    var line = { id: uid("line"), layerId: state.activeLayerId, points: draftPoints.slice(), lengthM: 0 };
    sheet().lines.push(line); recalcLine(line); renderLine(line); cancelDraft(); refreshTakeoff(); renderLayers();
  }

  // ------------- cable routes (visual only, no takeoff) -------------
  function finishRoute() {
    if (!draftPoints || draftPoints.length < 4) { cancelDraft(); return; }
    pushUndo();
    if (!sheet().routes) sheet().routes = [];
    var route = { id: uid("rte"), layerId: state.activeLayerId, points: draftPoints.slice(),
      description: "", stickLengthM: 4, lineWidthM: 0,
      straightPkgId: null, cornerPkgId: null, teePkgId: null,
      teeCount: 0, cornerCountOverride: null, lengthM: null };
    recalcRoute(route);
    sheet().routes.push(route); renderRoute(route); cancelDraft(); refreshTakeoff();
  }
  function recalcRoute(route) {
    var mpp = mppOf(sheet());
    route.lengthM = mpp ? polyLengthPx(route.points) * mpp : null;
  }
  function routeAutoCorners(route) { return Math.max(0, Math.floor(route.points.length / 2) - 2); }
  window.recalcRoute = recalcRoute;
  window.updateRouteWidth = function (routeId, lineWidthM) {
    var rn = routeNodes[routeId]; if (!rn) return;
    var mpp = mppOf(sheet());
    var worldW = (lineWidthM > 0 && mpp) ? lineWidthM / mpp : 0;
    rn._lineWidthM = lineWidthM; rn._useWorldWidth = worldW > 0;
    rn.strokeWidth(worldW > 0 ? worldW : 2 / stage.scaleX());
    shapeLayer.batchDraw();
  };
  function renderRoute(route) {
    var lay = layerById(route.layerId) || { color: "#38bdf8", visible: true };
    var k = 1 / stage.scaleX();
    var mpp = mppOf(sheet());
    var worldW = (route.lineWidthM > 0 && mpp) ? route.lineWidthM / mpp : 0;
    var initSW = worldW > 0 ? worldW : 2 * k;
    var kl = new Konva.Line({ points: route.points.slice(), stroke: lay.color, strokeWidth: initSW,
      lineCap: "round", lineJoin: "round", hitStrokeWidth: Math.max(12 * k, initSW + 4 * k),
      draggable: false, visible: lay.visible !== false });
    kl._routeId = route.id; kl._isRoute = true; kl._lineWidthM = route.lineWidthM || 0; kl._useWorldWidth = worldW > 0;
    kl.on("click tap", function (e) { if (tool === "select") { e.cancelBubble = true; select("route", route.id); } });
    routeNodes[route.id] = kl; shapeLayer.add(kl);
    liftUnassignedSymbols();
    shapeLayer.batchDraw();
  }

  // ------------- text annotations -------------
  function showTextInput(wx, wy) {
    var sc = stage.scaleX(), sp = stage.position(), cr = stage.container().getBoundingClientRect();
    var sx = wx * sc + sp.x + cr.left;
    var sy = wy * sc + sp.y + cr.top;
    var lay = layerById(state.activeLayerId) || { color: "#ffb02e" };
    var inp = document.createElement("textarea");
    inp.rows = 2;
    inp.placeholder = "Type text… Enter to place";
    inp.style.cssText =
      "position:fixed;left:" + Math.min(sx, window.innerWidth - 200) + "px;" +
      "top:" + Math.min(sy, window.innerHeight - 80) + "px;" +
      "width:200px;min-height:50px;" +
      "background:#1c232f;border:2px solid " + lay.color + ";color:#e7edf5;" +
      "font-family:'IBM Plex Sans',sans-serif;font-size:14px;" +
      "padding:5px 8px;border-radius:5px;z-index:9999;resize:both;outline:none;line-height:1.4;" +
      "box-shadow:0 4px 20px rgba(0,0,0,0.6)";
    document.body.appendChild(inp);
    // Defer focus so the mousedown event that triggered this doesn't steal it back
    requestAnimationFrame(function () { inp.focus(); });

    var committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      var text = inp.value.trim();
      if (inp.parentNode) document.body.removeChild(inp);
      if (!text) return;
      pushUndo();
      if (!sheet().texts) sheet().texts = [];
      var t = { id: uid("txt"), layerId: state.activeLayerId, x: wx, y: wy, text: text, fontSize: 14 };
      sheet().texts.push(t);
      renderText(t);
    }
    inp.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === "Escape") { committed = true; if (inp.parentNode) document.body.removeChild(inp); }
    };
    // Only wire blur after a short delay to prevent immediate fire
    setTimeout(function () { inp.onblur = commit; }, 300);
  }

  function renderText(txt) {
    var lay = layerById(txt.layerId) || { color: "#e7edf5", visible: true };
    // fontSize is in world-space px — Konva scales with the stage so no k multiplier needed
    var node = new Konva.Text({
      x: txt.x, y: txt.y,
      text: txt.text,
      fontSize: txt.fontSize || 14,
      fill: lay.color,
      fontFamily: "IBM Plex Sans, sans-serif",
      draggable: tool === "select",
      visible: lay.visible !== false
    });
    node._textId = txt.id; node._isText = true;
    node.on("dragend", function () { txt.x = node.x(); txt.y = node.y(); });
    node.on("click tap", function (e) {
      if (tool === "select") { e.cancelBubble = true; select("textAnnot", txt.id); }
    });
    node.on("dblclick dbltap", function (e) {
      e.cancelBubble = true;
      var sc = stage.scaleX(), sp = stage.position(), cr = stage.container().getBoundingClientRect();
      var sx = txt.x * sc + sp.x + cr.left;
      var sy = txt.y * sc + sp.y + cr.top;
      var inp = document.createElement("textarea");
      inp.value = txt.text; inp.rows = 2;
      inp.style.cssText =
        "position:fixed;left:" + Math.min(sx, window.innerWidth - 200) + "px;" +
        "top:" + Math.min(sy, window.innerHeight - 80) + "px;" +
        "width:200px;min-height:50px;" +
        "background:#1c232f;border:2px solid " + lay.color + ";color:#e7edf5;" +
        "font-family:'IBM Plex Sans',sans-serif;font-size:14px;" +
        "padding:5px 8px;border-radius:5px;z-index:9999;resize:both;outline:none;line-height:1.4;" +
        "box-shadow:0 4px 20px rgba(0,0,0,0.6)";
      document.body.appendChild(inp);
      requestAnimationFrame(function () { inp.focus(); inp.select(); });
      var committed = false;
      function commit() {
        if (committed) return; committed = true;
        var text = inp.value.trim();
        if (inp.parentNode) document.body.removeChild(inp);
        if (text) { pushUndo(); txt.text = text; node.text(text); shapeLayer.batchDraw(); }
      }
      inp.onkeydown = function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
        if (e.key === "Escape") { committed = true; if (inp.parentNode) document.body.removeChild(inp); }
      };
      setTimeout(function () { inp.onblur = commit; }, 300);
    });
    textNodes[txt.id] = node;
    shapeLayer.add(node);
    shapeLayer.batchDraw();
  }
  function recalcLine(line) { var mpp = mppOf(sheet()); line.lengthM = mpp ? polyLengthPx(line.points) * mpp : null; }
  function renderLine(line) {
    var lay = layerById(line.layerId) || { color: "#ffb02e", visible: true };
    var k = 1 / stage.scaleX();
    var kl = new Konva.Line({ points: line.points.slice(), stroke: lay.color, strokeWidth: 3 * k,
      lineCap: "round", lineJoin: "round", hitStrokeWidth: 14, draggable: false, visible: lay.visible !== false });
    kl._lineId = line.id;
    var lp = pointAtHalf(line.points);
    // Length label intentionally not shown on canvas — lengths accumulate in the layer total only.
    // We keep a stub Group so lineNodes[id].label always exists for code that expects it.
    var label = new Konva.Group({ x: lp.x, y: lp.y, visible: false, listening: false });
    label._isLineLabel = true;
    kl.on("click tap", function (e) { if (tool === "select") { e.cancelBubble = true; select("line", line.id); } });
    lineNodes[line.id] = { line: kl, label: label };
    shapeLayer.add(kl); shapeLayer.add(label);
    liftUnassignedSymbols();
    shapeLayer.batchDraw();
  }
  function repositionLabel(line) { /* label hidden — nothing to reposition */ }
  function refreshLineLabel(line)  { /* label hidden — nothing to refresh */ }
  function recalcAllLines() { var sh = sheet(); if (!sh) return; sh.lines.forEach(function (l) { recalcLine(l); refreshLineLabel(l); }); (sh.routes || []).forEach(recalcRoute); refreshTakeoff(); renderLayers(); }

  // ------------- selection -------------
  function select(kind, id) {
    deselect(); selected = { kind: kind, id: id };
    if (kind === "symbol") {
      var n = symbolNodes[id]; n.shadowColor("#ffb02e"); n.shadowBlur(16); n.shadowOpacity(0.9);
      if (transformer) transformer.nodes([n]);
      var s = sheet().symbols.find(function (x) { return x.id === id; });
      if (s && $("symSize")) { $("symSize").value = Math.round(s.size || 30); $("symSizeVal").textContent = Math.round(s.size || 30); }
      switchTab("properties");
      window._appSelectedSym = s;
      renderPropertiesPanel(s);
    } else if (kind === "line") {
      var ln = lineNodes[id].line; ln.strokeWidth(5.4 / stage.scaleX()); ln.shadowColor("#fff"); ln.shadowBlur(8);
      if (transformer) transformer.nodes([]);
    } else if (kind === "route") {
      var rn = routeNodes[id]; rn.shadowColor("#38bdf8"); rn.shadowBlur(10);
      if (!rn._useWorldWidth) rn.strokeWidth(4 / stage.scaleX());
      if (transformer) transformer.nodes([]);
      var _rsh = sheet(), _robj = _rsh && (_rsh.routes || []).find(function (r) { return r.id === id; });
      if (_robj) { switchTab("properties"); window._appSelectedRoute = _robj; if (window.renderRouteProperties) window.renderRouteProperties(_robj); }
    } else if (kind === "textAnnot") {
      var tn = textNodes[id]; tn.shadowColor("#ffb02e"); tn.shadowBlur(10); tn.shadowOpacity(0.8);
      if (transformer) transformer.nodes([tn]);
    }
    shapeLayer.batchDraw();
  }
  function deselect() {
    if (transformer) transformer.nodes([]);
    if (!selected) { shapeLayer.batchDraw(); return; }
    if (selected.kind === "symbol" && symbolNodes[selected.id]) {
      symbolNodes[selected.id].shadowBlur(0);
      symbolNodes[selected.id].scaleX(1); symbolNodes[selected.id].scaleY(1);
    }
    else if (selected.kind === "line"   && lineNodes[selected.id])  { var ln = lineNodes[selected.id].line; ln.shadowBlur(0); ln.strokeWidth(3 / stage.scaleX()); }
    else if (selected.kind === "route"  && routeNodes[selected.id]) { var _rnd = routeNodes[selected.id]; _rnd.shadowBlur(0); if (!_rnd._useWorldWidth) _rnd.strokeWidth(2 / stage.scaleX()); }
    else if (selected.kind === "textAnnot" && textNodes[selected.id]) textNodes[selected.id].shadowBlur(0);
    selected = null; shapeLayer.batchDraw();
  }
  function deleteSelected() {
    if (!selected) return; var sh = sheet();
    pushUndo();
    if (transformer) transformer.nodes([]);
    if (selected.kind === "symbol") {
      sh.symbols = sh.symbols.filter(function (s) { return s.id !== selected.id; });
      symbolNodes[selected.id].destroy(); delete symbolNodes[selected.id];
      if (refLabelNodes[selected.id]) { refLabelNodes[selected.id].destroy(); delete refLabelNodes[selected.id]; }
    } else if (selected.kind === "line") {
      sh.lines = sh.lines.filter(function (l) { return l.id !== selected.id; });
      var n = lineNodes[selected.id]; n.line.destroy(); n.label.destroy(); delete lineNodes[selected.id];
    } else if (selected.kind === "route") {
      sh.routes = (sh.routes || []).filter(function (r) { return r.id !== selected.id; });
      routeNodes[selected.id].destroy(); delete routeNodes[selected.id];
    } else if (selected.kind === "textAnnot") {
      sh.texts = (sh.texts || []).filter(function (t) { return t.id !== selected.id; });
      textNodes[selected.id].destroy(); delete textNodes[selected.id];
    }
    selected = null; shapeLayer.batchDraw(); refreshTakeoff(); renderLayers();
  }

  function renderCalibration() {
    if (calNodes) ["line", "h1", "h2", "label"].forEach(function (k) { calNodes[k] && calNodes[k].destroy(); });
    calNodes = null;
    var sh = sheet(); if (!sh || !sh.scale) { updateScaleStatus(); return; }
    var sc = sh.scale, k = 1 / stage.scaleX();
    var line = new Konva.Line({ points: [sc.p1.x, sc.p1.y, sc.p2.x, sc.p2.y], stroke: "#ffb02e",
      strokeWidth: 2 * k, dash: [10 * k, 6 * k], lineCap: "round", listening: false });
    function handle(pt, which) {
      var h = new Konva.Circle({ x: pt.x, y: pt.y, radius: 7 * k, fill: "#ffb02e", stroke: "#1a130a", strokeWidth: 1.5 * k, draggable: true });
      h.on("dragmove", function () {
        sc[which] = { x: h.x(), y: h.y() };
        line.points([sc.p1.x, sc.p1.y, sc.p2.x, sc.p2.y]);
        updateCalLabel(); recalcAllLines(); calLayer.batchDraw(); updateScaleStatus();
      });
      h.on("dblclick dbltap", function (e) { e.cancelBubble = true; openScaleModal(); });
      return h;
    }
    var h1 = handle(sc.p1, "p1"), h2 = handle(sc.p2, "p2");
    calNodes = { line: line, h1: h1, h2: h2 };
    calLayer.add(line, h1, h2); calLayer.batchDraw();
  }
  function updateCalLabel() { /* label removed — nothing to update */ }
  function updateScaleStatus() {
    var mpp = mppOf(sheet()), el = $("stScale");
    if (mpp) { el.textContent = (1 / mpp).toFixed(1) + " px/m"; el.classList.remove("scale-warn"); }
    else { el.textContent = "not set"; el.classList.add("scale-warn"); }
    $("stHint").textContent = !sheet() ? "Upload a plan to begin" : (mpp ? "Scale set — measurements are live" : "Set scale to enable measurement");
  }
  function openScaleModal() {
    var sh = sheet(); if (!sh || !sh.scale) { toast("Draw a calibration line first", true); return; }
    $("scalePxHint").textContent = "Calibration line = " + dist(sh.scale.p1, sh.scale.p2).toFixed(1) + " px on the plan";
    $("scaleValue").value = sh.scale.realMeters != null ? sh.scale.realMeters : "";
    openModal("modalScale"); setTimeout(function () { $("scaleValue").focus(); }, 50);
  }
  function applyScale() {
    var v = parseFloat($("scaleValue").value), f = parseFloat($("scaleUnit").value);
    if (!(v > 0)) { toast("Enter a length greater than 0", true); return; }
    sheet().scale.realMeters = v * f;
    closeModal("modalScale"); renderCalibration(); recalcAllLines(); updateScaleStatus();
    toast("Scale applied to " + sheet().name); if (tool === "calibrate") setTool("select");
  }

  // ------------- layers panel -------------
  function addLayer(name, color) {
    var l = { id: uid("lay"), name: name || ("Layer " + (state.layers.length + 1)),
      color: color || LAYER_COLORS[state.layers.length % LAYER_COLORS.length], visible: true, part: null };
    state.layers.push(l); state.activeLayerId = l.id; renderLayers(); refreshTakeoff(); return l;
  }
  function renderLayers() {
    var box = $("layerList"); box.innerHTML = ""; $("layerCount").textContent = state.layers.length;
    state.layers.forEach(function (l) {
      var lenM = 0; state.sheets.forEach(function (sh) { sh.lines.forEach(function (x) { if (x.layerId === l.id) lenM += (x.lengthM || 0); }); });
      var row = document.createElement("div");
      row.className = "layer-row" + (l.id === state.activeLayerId ? " active" : "");
      row.innerHTML =
        // Row 1: colour swatch + name + action buttons
        '<div class="layer-row-top">' +
          '<span class="layer-swatch" style="background:' + l.color + '" title="Click to change colour"></span>' +
          '<span class="layer-name-text">' + escapeHtml(l.name) + '</span>' +
          '<button class="icon-btn rename-btn" title="Rename">✏️</button>' +
          '<button class="icon-btn vis">' + (l.visible ? "&#128065;" : "&#128584;") + '</button>' +
          '<button class="icon-btn del" title="Delete">&#10005;</button>' +
        '</div>' +
        // Row 2: length + part link
        '<div class="layer-row-bottom">' +
          '<span class="layer-meta">' + lenM.toFixed(1) + ' m</span>' +
          '<span class="layer-part-link">' + (l.part
            ? '&#128279; ' + escapeHtml(l.part.part_no) + ' — ' + escapeHtml(l.part.description)
            : '<span style="color:var(--faint)">no part linked</span>') +
          '</span>' +
        '</div>';

      row.onclick = function (e) {
        if (e.target.closest(".icon-btn") || e.target.classList.contains("layer-swatch")) return;
        state.activeLayerId = l.id; renderLayers();
        if (window.refreshLoadMonitor) window.refreshLoadMonitor();
      };
      row.querySelector(".layer-swatch").onclick = function (e) {
        e.stopPropagation();
        var i = document.createElement("input"); i.type = "color"; i.value = l.color;
        i.oninput = function () { l.color = i.value; restyleLayer(l); renderLayers(); };
        i.click();
      };
      row.querySelector(".rename-btn").onclick = function (e) { e.stopPropagation(); openRenameLayerModal(l); };
      row.querySelector(".vis").onclick = function (e) { e.stopPropagation(); l.visible = !l.visible; applyLayerVisibility(l); renderLayers(); };
      row.querySelector(".del").onclick = function (e) { e.stopPropagation(); deleteLayer(l.id); };
      row.querySelector(".layer-part-link").onclick = function (e) { e.stopPropagation(); openAssign("layer", l.id); };
      box.appendChild(row);
    });
  }

  function openRenameLayerModal(layer) {
    $("renameLayerInput").value = layer.name;
    $("renameLayerSave").onclick = function () {
      var v = $("renameLayerInput").value.trim();
      if (v) { layer.name = v; renderLayers(); refreshTakeoff(); }
      closeModal("modalRenameLayer");
    };
    openModal("modalRenameLayer");
    setTimeout(function () { $("renameLayerInput").select(); }, 50);
  }
  function restyleLayer(l) {
    if (sheet()) sheet().lines.forEach(function (x) {
      if (x.layerId === l.id) { var n = lineNodes[x.id]; if (n) { n.line.stroke(l.color); } }
    });
    shapeLayer.batchDraw();
  }
  function applyLayerVisibility(l) {
    if (sheet()) {
      sheet().lines.forEach(function (x) {
        if (x.layerId === l.id) { var n = lineNodes[x.id]; if (n) { n.line.visible(l.visible); n.label.visible(l.visible); } }
      });
      (sheet().routes || []).forEach(function (x) {
        if (x.layerId === l.id) { var n = routeNodes[x.id]; if (n) n.visible(l.visible); }
      });
      (sheet().texts || []).forEach(function (x) {
        if (x.layerId === l.id) { var n = textNodes[x.id]; if (n) n.visible(l.visible); }
      });
      sheet().symbols.forEach(function (s) {
        // A symbol belongs to a layer if visibleLayerId matches, OR if the
        // type-level palLayerId matches (assigned via Assign Part modal).
        var typeCfg = state.symbolTypes[s.type] || {};
        var onThisLayer = (s.visibleLayerId === l.id) ||
                          (!s.visibleLayerId && typeCfg.palLayerId === l.id);
        if (onThisLayer) {
          var n = symbolNodes[s.id]; if (n) n.visible(l.visible);
          var rl = refLabelNodes[s.id]; if (rl) rl.visible(l.visible && !!(s.refNo));
        }
      });
    }
    shapeLayer.batchDraw();
  }
  function deleteLayer(id) {
    var has = state.sheets.some(function (sh) { return sh.lines.some(function (x) { return x.layerId === id; }); });
    if (has && !confirm("Delete this layer and ALL its lines on every sheet?")) return;
    state.sheets.forEach(function (sh) {
      sh.lines.filter(function (x) { return x.layerId === id; }).forEach(function (x) { var n = lineNodes[x.id]; if (n) { n.line.destroy(); n.label.destroy(); delete lineNodes[x.id]; } });
      sh.lines = sh.lines.filter(function (x) { return x.layerId !== id; });
    });
    state.layers = state.layers.filter(function (l) { return l.id !== id; });
    if (state.activeLayerId === id) state.activeLayerId = state.layers[0] ? state.layers[0].id : null;
    shapeLayer.batchDraw(); renderLayers(); refreshTakeoff();
  }

  // ------------- sheets panel -------------
  function renderSheets() {
    var box = $("sheetList"); box.innerHTML = ""; $("sheetCount").textContent = state.sheets.length;
    if (!state.sheets.length) { box.innerHTML = '<p style="color:var(--faint);font-size:12px;margin:4px 0">No sheets yet. Click ＋ or drop a plan.</p>'; return; }
    state.sheets.forEach(function (sh) {
      var devs = sh.symbols.length, runs = sh.lines.length;
      var row = document.createElement("div");
      row.className = "layer-row" + (sh.id === state.activeSheetId ? " active" : "");
      row.innerHTML =
        '<input class="layer-name" value="' + escapeHtml(sh.name) + '" />' +
        '<span class="layer-meta">' + devs + '◦ ' + runs + '/</span>' +
        '<button class="icon-btn del" title="Delete sheet">&#10005;</button>';
      row.onclick = function (e) {
        if (e.target.closest(".icon-btn") || e.target.classList.contains("layer-name")) return;
        if (sh.id !== state.activeSheetId) { state.activeSheetId = sh.id; renderSheets(); renderActiveSheet(); }
      };
      var ni = row.querySelector(".layer-name");
      ni.onchange = function () { sh.name = ni.value; }; ni.onclick = function (e) { e.stopPropagation(); };
      row.querySelector(".del").onclick = function (e) {
        e.stopPropagation();
        if (!confirm("Delete sheet \"" + sh.name + "\" and its markups?")) return;
        state.sheets = state.sheets.filter(function (x) { return x.id !== sh.id; });
        if (state.activeSheetId === sh.id) state.activeSheetId = state.sheets[0] ? state.sheets[0].id : null;
        renderSheets(); renderActiveSheet(); refreshTakeoff();
      };
      box.appendChild(row);
    });
  }

  // ------------- symbol palette -------------
  function renderPalette() {
    var all = allSymbols();
    var box = $("symbolPalette"); box.innerHTML = ""; $("symCount").textContent = all.length;
    if (!all.length) {
      box.innerHTML = '<p style="color:var(--faint);font-size:11px;margin:8px 6px;line-height:1.5">' +
        'No symbols yet.<br>Click <strong style="color:var(--text)">＋</strong> to add one manually, ' +
        'or click <strong style="color:var(--text)">DXF</strong> to import from a DXF file.' +
        '</p>';
      return;
    }
    [["electrical", "Electrical"], ["data", "Data / Comms"], ["mechanical", "Mechanical"], ["custom", "Custom"]].forEach(function (c) {
      var items = all.filter(function (s) { return s.category === c[0]; });
      if (!items.length) return;
      var lab = document.createElement("div"); lab.className = "cat-label";
      lab.style.setProperty("--c", LIB.categoryColors[c[0]] || "#8a98ab"); lab.textContent = c[1]; box.appendChild(lab);
      var grid = document.createElement("div"); grid.className = "sym-grid";
      items.forEach(function (s) {
        var isCustom = !!(s.custom || customSymbol(s.id));
        var el = document.createElement("div"); el.className = "sym"; el.dataset.type = s.id;
        el.innerHTML = '<img src="' + symImageURL(s.id) + '"><span>' + escapeHtml(s.name) + '</span>';

        // Hover action buttons
        var actions = document.createElement("div");
        actions.className = "sym-actions";

        var editBtn = document.createElement("button");
        editBtn.className = "sym-action-btn";
        editBtn.title = "Edit symbol";
        editBtn.textContent = "\u270f";
        (function(sid){ editBtn.onclick = function (e) { e.stopPropagation(); openSymbolModal(sid); }; })(s.id);
        actions.appendChild(editBtn);

        if (isCustom) {
          var delBtn = document.createElement("button");
          delBtn.className = "sym-action-btn del";
          delBtn.title = "Delete symbol";
          delBtn.textContent = "\u00d7";
          (function(sid){ delBtn.onclick = function (e) { e.stopPropagation(); deleteCustomSymbol(sid); }; })(s.id);
          actions.appendChild(delBtn);
        }
        el.appendChild(actions);

        el.onclick = function (e) {
          if (e.target.closest(".sym-actions")) return;
          activeSymbolType = s.id;
          document.querySelectorAll(".sym").forEach(function (x) { x.classList.remove("active"); });
          el.classList.add("active"); setTool("symbol");
        };
        el.oncontextmenu = function (e) { e.preventDefault(); openAssign("symbol", s.id); };
        el.title = "Click to place · right-click for symbol defaults";
        grid.appendChild(el);
      });
      box.appendChild(grid);
    });
  }
  function deleteCustomSymbol(id) {
    var used = state.sheets.some(function (sh) { return sh.symbols.some(function (s) { return s.type === id; }); });
    if (used && !confirm("This custom symbol is placed on the plan. Delete it and remove those placements?")) return;
    if (used) state.sheets.forEach(function (sh) {
      sh.symbols.filter(function (s) { return s.type === id; }).forEach(function (s) {
        var n = symbolNodes[s.id]; if (n) { n.destroy(); delete symbolNodes[s.id]; }
        var rl = refLabelNodes[s.id]; if (rl) { rl.destroy(); delete refLabelNodes[s.id]; }
      });
      sh.symbols = sh.symbols.filter(function (s) { return s.type !== id; });
    });
    state.customSymbols = (state.customSymbols || []).filter(function (s) { return s.id !== id; });
    fetch("/api/symbols/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {});
    delete state.symbolTypes[id]; delete symbolImages[id];
    if (activeSymbolType === id) { activeSymbolType = null; if (tool === "symbol") setTool("select"); }
    shapeLayer.batchDraw(); renderPalette(); refreshTakeoff();
    toast("Custom symbol deleted");
  }

  // ------------- parts (backend + custom) -------------
  function fetchParts(q) {
    return fetch("/api/parts?q=" + encodeURIComponent(q || "") + "&limit=60").then(function (r) { return r.json(); })
      .then(function (j) { if (j.error) throw new Error(j.error); return j.parts; });
  }
  function filterCustomParts(q) {
    q = (q || "").toLowerCase();
    return (state.customParts || []).filter(function (p) {
      return !q || ((p.part_no || "") + " " + (p.description || "") + " " + (p.category || "")).toLowerCase().indexOf(q) !== -1;
    });
  }
  // Always resolves: { parts: [custom..., db...], err: <db error or null> }
  function searchParts(q) {
    return fetchParts(q).then(function (parts) { return { parts: parts, err: null }; })
      .catch(function (e) { return { parts: [], err: e.message }; })
      .then(function (res) { return { parts: filterCustomParts(q).concat(res.parts), err: res.err }; });
  }
  function partRowHtml(p) {
    return '<div class="pn">' + escapeHtml(p.part_no) + (p._custom ? ' <span class="chip" style="color:var(--green)">custom</span>' : "") +
      '</div><div class="desc">' + escapeHtml(p.description) +
      '</div><div class="price">cost ' + fmt$(p.cost) + ' · retail ' + fmt$(p.retail) +
      (p.labour ? ' · ' + p.labour + 'h' : "") + (p.unit ? ' · /' + escapeHtml(p.unit) : "") + '</div>';
  }
  function renderPartsLibrary(q) {
    var box = $("partsResults"); box.innerHTML = '<p style="color:var(--faint)">Searching…</p>';
    searchParts(q).then(function (res) {
      box.innerHTML = "";
      if (res.err) box.innerHTML = '<p class="unlinked" style="margin-top:0">DB: ' + escapeHtml(res.err) + ' — check Settings. (Custom parts still shown.)</p>';
      if (!res.parts.length) { box.innerHTML += '<p style="color:var(--faint)">No parts found.</p>'; return; }
      res.parts.forEach(function (p) { var d = document.createElement("div"); d.className = "part-row"; d.innerHTML = partRowHtml(p); box.appendChild(d); });
    });
  }

  // ------------- assign part modal -------------
  var assignCtx = null;
  function openAssign(kind, key, instanceSym) {
    // instanceSym: when set, assign part to a single placed instance (sym.partOverride)
    // rather than to the shared symbol type.
    var existingObj;
    if (kind === "layer") {
      existingObj = layerById(key) || {};
    } else if (instanceSym) {
      var typeCfg = state.symbolTypes[key] || {};
      existingObj = {
        part: instanceSym.partOverride !== undefined ? instanceSym.partOverride : (typeCfg.part || null),
        labourHrs: typeCfg.labourHrs || 0, dropM: typeCfg.dropM || 0, dropLayerId: typeCfg.dropLayerId || null,
        defaultCurrentA: typeCfg.defaultCurrentA != null ? typeCfg.defaultCurrentA : null
      };
    } else {
      existingObj = state.symbolTypes[key] || {};
    }
    assignCtx = { kind: kind, key: key, tempPart: existingObj.part || null, instanceSym: instanceSym || null };
    $("assignTitle").textContent = kind === "layer"
      ? "Link part to layer: " + (layerById(key) || {}).name
      : (instanceSym ? "Part override — " : "Symbol defaults — ") + symInfo(key).name;
    $("assignSearch").value = "";
    var isSym = kind === "symbol";
    $("dropConfig").style.display = isSym ? "block" : "none";
    $("assignSave").style.display = "inline-flex";
    $("labourHrs").value = (isSym ? existingObj.labourHrs : existingObj.labourHrsPerM) || "";
    if (isSym) {
      populateDropLayers();
      $("dropLen").value = existingObj.dropM || "";
      $("dropLayer").value = existingObj.dropLayerId || "";
      $("assignCurrentA").value = existingObj.defaultCurrentA != null ? existingObj.defaultCurrentA : "";
    }
    renderAssignResults(""); openModal("modalAssign"); setTimeout(function () { $("assignSearch").focus(); }, 50);
  }
  function populateDropLayers() {
    var sel = $("dropLayer"); sel.innerHTML = '<option value="">— none —</option>';
    state.layers.forEach(function (l) { var o = document.createElement("option"); o.value = l.id; o.textContent = l.name; sel.appendChild(o); });
  }
  function renderAssignResults(q) {
    var box = $("assignResults"); box.innerHTML = '<p style="color:var(--faint)">Searching…</p>';
    searchParts(q).then(function (res) {
      box.innerHTML = "";
      if (res.err) box.innerHTML = '<p class="unlinked" style="margin-top:0">DB: ' + escapeHtml(res.err) + '</p>';
      if (!res.parts.length) { box.innerHTML += '<p style="color:var(--faint)">No parts found.</p>'; return; }
      res.parts.forEach(function (p) {
        var d = document.createElement("div"); d.className = "part-row"; d.innerHTML = partRowHtml(p);
        if (assignCtx.tempPart && assignCtx.tempPart.part_no === p.part_no) d.style.borderColor = "var(--accent)";
        d.onclick = function () { pickPart(p, d, box); };
        box.appendChild(d);
      });
    });
  }
  function pickPart(p, el, box) {
    assignCtx.tempPart = p;
    Array.prototype.forEach.call(box.children, function (c) { c.style.borderColor = ""; });
    if (el) el.style.borderColor = "var(--accent)";
    // prefill labour from the part if the field is blank
    if (!$("labourHrs").value && p.labour) $("labourHrs").value = p.labour;
  }
  function assignSave() {
    if (!assignCtx) return;
    var hrs = parseFloat($("labourHrs").value) || 0;
    if (assignCtx.kind === "layer") {
      var l = layerById(assignCtx.key);
      if (l) { l.part = assignCtx.tempPart || null; l.labourHrsPerM = hrs; }
    } else if (assignCtx.instanceSym) {
      // Per-instance override: store on the sym object itself, not on the shared type
      assignCtx.instanceSym.partOverride = assignCtx.tempPart || null;
    } else {
      var currentAVal = parseFloat($("assignCurrentA").value);
      state.symbolTypes[assignCtx.key] = { part: assignCtx.tempPart || null, labourHrs: hrs,
        dropM: parseFloat($("dropLen").value) || 0, dropLayerId: $("dropLayer").value || null,
        defaultCurrentA: isNaN(currentAVal) ? null : currentAVal };
    }
    closeModal("modalAssign"); renderLayers(); refreshTakeoff(); toast("Saved");
    // Refresh properties panel if a symbol is selected so part badge + drop section update
    if (window._appSelectedSym && window.renderPropertiesPanel) window.renderPropertiesPanel(window._appSelectedSym);
  }
  function clearAssign() {
    if (!assignCtx) return;
    if (assignCtx.kind === "layer") { var l = layerById(assignCtx.key); if (l) { l.part = null; l.labourHrsPerM = 0; } }
    else if (assignCtx.instanceSym) {
      // Clear the per-instance override (revert to type-level part)
      delete assignCtx.instanceSym.partOverride;
    } else {
      delete state.symbolTypes[assignCtx.key];
    }
    closeModal("modalAssign"); renderLayers(); refreshTakeoff();
    if (window._appSelectedSym && window.renderPropertiesPanel) window.renderPropertiesPanel(window._appSelectedSym);
  }

  // ------------- takeoff -------------
  function computeTakeoff() {
    var devices = {}, runs = {};
    state.layers.forEach(function (l) { runs[l.id] = { layer: l, measuredM: 0, dropM: 0 }; });
    state.sheets.forEach(function (sh) {
      sh.symbols.forEach(function (s) {
        // Symbols with a per-instance part override get their own takeoff bucket
        // keyed as "type::instanceId" so they don't merge with the type group.
        var bucketKey = s.hasOwnProperty("partOverride") ? s.type + "::" + s.id : s.type;
        if (!devices[bucketKey]) {
          devices[bucketKey] = { type: s.type, count: 0, instancePart: s.hasOwnProperty("partOverride") ? s.partOverride : undefined, bucketKey: bucketKey };
        }
        devices[bucketKey].count++;
      });
      sh.lines.forEach(function (l) { if (runs[l.layerId]) runs[l.layerId].measuredM += (l.lengthM || 0); });
    });
    // Per-symbol drop lengths.
    // Target layer: type-level dropLayerId (set via Assign Part) OR the symbol's visibleLayerId.
    // Drop length: per-symbol dropLength (set in Properties, defaults to 1m).
    state.sheets.forEach(function (sh) {
      sh.symbols.forEach(function (s) {
        var cfg = state.symbolTypes[s.type] || {};
        var targetLayerId = cfg.dropLayerId || s.visibleLayerId || null;
        if (!targetLayerId || !runs[targetLayerId]) return;
        var dl = (s.dropLength != null) ? s.dropLength : 1;
        runs[targetLayerId].dropM += dl;
      });
    });
    return { devices: Object.values(devices), runs: Object.values(runs) };
  }
  // Build the effective takeoff rows, applying any manual overrides.
  function takeoffRows() {
    var t = computeTakeoff(), w = (state.wastagePct || 0) / 100, rate = state.labourRate || 0, rows = [];
    t.devices.forEach(function (d) {
      var cfg = state.symbolTypes[d.type] || {};
      // Per-instance override: use instancePart (may be null = explicitly no part).
      // If no override bucket, use the type-level part.
      var part = d.instancePart !== undefined ? d.instancePart : (cfg.part || null);
      var isInstanceBucket = d.bucketKey && d.bucketKey !== d.type;
      // Qty/hrs overrides only apply to the type-level bucket
      var autoQty = d.count, effQty = (!isInstanceBucket && cfg.qtyOverride != null) ? cfg.qtyOverride : autoQty;
      var autoHrs = d.count * (cfg.labourHrs || 0), effHrs = (!isInstanceBucket && cfg.hrsOverride != null) ? cfg.hrsOverride : autoHrs;
      var rowName = symInfo(d.type).name + (isInstanceBucket ? " ★" : "");
      rows.push({ kind: "dev", id: d.type, name: rowName, part: part, color: null, unit: "ea",
        autoQty: autoQty, effQty: effQty, qtyOv: !isInstanceBucket && cfg.qtyOverride != null,
        autoHrs: autoHrs, effHrs: effHrs, hrsOv: !isInstanceBucket && cfg.hrsOverride != null,
        matCost: effQty * (part ? part.cost : 0), matRetail: effQty * (part ? part.retail : 0), labour: effHrs * rate,
        meta: (isInstanceBucket ? "instance override" : (cfg.dropM && cfg.dropLayerId) ? ("drop " + cfg.dropM + "m → " + ((layerById(cfg.dropLayerId) || {}).name || "?")) : "") });
    });
    t.runs.forEach(function (run) {
      if (!(run.measuredM || run.dropM)) return;
      var lay = run.layer, part = lay.part || null, installed = run.measuredM + run.dropM;
      var autoQty = installed * (1 + w), effQty = lay.qtyOverride != null ? lay.qtyOverride : autoQty;
      var autoHrs = installed * (lay.labourHrsPerM || 0), effHrs = lay.hrsOverride != null ? lay.hrsOverride : autoHrs;
      rows.push({ kind: "cab", id: lay.id, name: lay.name, part: part, color: lay.color, unit: "m",
        autoQty: autoQty, effQty: effQty, qtyOv: lay.qtyOverride != null,
        autoHrs: autoHrs, effHrs: effHrs, hrsOv: lay.hrsOverride != null,
        matCost: effQty * (part ? part.cost : 0), matRetail: effQty * (part ? part.retail : 0), labour: effHrs * rate,
        meta: run.measuredM.toFixed(2) + "m" + (run.dropM ? (" + " + run.dropM.toFixed(2) + "m drops") : "") });
    });
    return { rows: rows, rate: rate };
  }
  function setOverride(kind, id, key, val) {
    var obj = kind === "dev" ? (state.symbolTypes[id] || (state.symbolTypes[id] = {})) : layerById(id);
    if (!obj) return;
    obj[key] = (val == null || isNaN(val)) ? null : val;
  }
  function qfmt(row) { return row.kind === "cab" ? row.effQty.toFixed(2) : (Number.isInteger(row.effQty) ? String(row.effQty) : row.effQty.toFixed(2)); }

  function refreshTakeoff() {
    var data = takeoffRows(), rows = data.rows, rate = data.rate;
    var matCost = 0, matRetail = 0, totHrs = 0;
    var inpStyle = "width:64px;text-align:right;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--text);font-family:var(--mono)";
    var numStyle = "width:62px;text-align:right;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:3px 5px;color:var(--text);font-family:var(--mono);font-size:11px";
    var ovStyle = numStyle + ";border-color:var(--accent);color:var(--accent)";
    function numInput(row, key) {
      var ov = key === "qty" ? row.qtyOv : row.hrsOv;
      var val = key === "qty" ? qfmt(row) : (row.effHrs ? row.effHrs.toFixed(2) : "");
      var auto = key === "qty" ? (row.kind === "cab" ? row.autoQty.toFixed(2) : row.autoQty) : row.autoHrs.toFixed(2);
      return '<input class="ta-num" data-kind="' + row.kind + '" data-id="' + escapeHtml(row.id) + '" data-k="' + key +
        '" type="number" step="any" value="' + val + '" placeholder="' + auto + '" title="auto = ' + auto + '" style="' + (ov ? ovStyle : numStyle) + '">';
    }
    var html = '<div class="totals-row" style="border-bottom:1px solid var(--border);margin-bottom:6px;padding-bottom:8px;gap:14px">' +
      '<span>Cable wastage <input id="wasteInp" type="number" step="any" value="' + (state.wastagePct || 0) + '" style="' + inpStyle + '"> %</span>' +
      '<span>Labour rate <input id="rateInp" type="number" step="any" value="' + rate + '" style="' + inpStyle + '"> $/h</span></div>';
    html += '<p class="hint" style="margin:0 0 6px">Qty &amp; Hrs are editable — type to override, blank to reset. Edited rows show ↺.</p>';
    html += '<table class="takeoff"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Retail</th><th class="num">Hrs</th><th class="num">Labour</th></tr></thead><tbody>';

    // ── Device section: group by part number ─────────────────────────────
    function sectionDevices() {
      var list = rows.filter(function (r) { return r.kind === "dev"; });
      html += '<tr class="group-head"><td colspan="6">Devices (count)</td></tr>';
      if (!list.length) { html += '<tr><td colspan="6" style="color:var(--faint)">No symbols placed</td></tr>'; return; }

      // Split into linked (has a part) and unlinked (no part).
      // Merge linked rows that share the same part_no into one combined row.
      var partGroups = {};   // part_no -> { part, qty, matCost, matRetail, hrs, labour, symNames, rows[] }
      var unlinked   = [];   // rows with no part

      list.forEach(function (row) {
        if (!row.part) { unlinked.push(row); return; }
        var pno = row.part.part_no;
        if (!partGroups[pno]) {
          partGroups[pno] = { part: row.part, qty: 0, matCost: 0, matRetail: 0, hrs: 0, labour: 0, symNames: [], rows: [] };
        }
        var g = partGroups[pno];
        g.qty      += row.effQty;
        g.matCost  += row.matCost;
        g.matRetail+= row.matRetail;
        g.hrs      += row.effHrs;
        g.labour   += row.labour;
        // Collect symbol-type names for the subtitle, deduping
        var lbl = row.name;
        if (g.symNames.indexOf(lbl) === -1) g.symNames.push(lbl);
        g.rows.push(row);
      });

      // Render one row per part number (sorted by part_no)
      var pnos = Object.keys(partGroups).sort();
      pnos.forEach(function (pno) {
        var g = partGroups[pno];
        matCost   += g.matCost;
        matRetail += g.matRetail;
        totHrs    += g.hrs;

        // If only one underlying row we can still show qty/hrs override inputs keyed to that row
        var singleRow = g.rows.length === 1 ? g.rows[0] : null;
        var edited = singleRow && (singleRow.qtyOv || singleRow.hrsOv)
          ? ' <a href="#" class="layer-part" data-reset-kind="dev" data-reset-id="' + escapeHtml(singleRow.id) + '" title="Reset to auto">↺</a>' : "";

        var symSubtitle = '<span class="layer-meta">' + escapeHtml(g.symNames.join(", ")) + '</span>';
        var descLine    = g.part.description ? '<br><span style="color:var(--muted);font-size:11px">' + escapeHtml(g.part.description) + '</span>' : "";

        var qtyCell, hrsCell;
        if (singleRow) {
          qtyCell = numInput(singleRow, "qty");
          hrsCell = numInput(singleRow, "hrs");
        } else {
          // Multiple underlying rows merged — show totals as plain text (no override input for merged groups)
          qtyCell = '<span style="font-family:var(--mono);font-size:12px">' + g.qty + '</span>';
          hrsCell = '<span style="font-family:var(--mono);font-size:12px">' + g.hrs.toFixed(2) + '</span>';
        }

        html += "<tr><td>" +
          "<strong>" + escapeHtml(pno) + "</strong>" + descLine + "<br>" + symSubtitle + edited +
          '</td><td class="num">' + qtyCell +
          '</td><td class="num">' + fmt$(g.matCost) +
          '</td><td class="num">' + fmt$(g.matRetail) +
          '</td><td class="num">' + hrsCell +
          '</td><td class="num">' + fmt$(g.labour) + "</td></tr>";
      });

      // Unlinked symbols — show one row per symbol type with a "link part" prompt
      unlinked.forEach(function (row) {
        matCost   += row.matCost;
        matRetail += row.matRetail;
        totHrs    += row.effHrs;
        var edited = (row.qtyOv || row.hrsOv)
          ? ' <a href="#" class="layer-part" data-reset-kind="dev" data-reset-id="' + escapeHtml(row.id) + '" title="Reset to auto">↺</a>' : "";
        html += "<tr><td>" +
          '<span style="color:var(--muted)">' + escapeHtml(row.name) + '</span>' +
          ' <a href="#" class="unlinked" data-sym="' + escapeHtml(row.id) + '">link part</a>' +
          (row.meta ? '<br><span class="layer-meta">' + escapeHtml(row.meta) + "</span>" : "") + edited +
          '</td><td class="num">' + numInput(row, "qty") +
          '</td><td class="num">' + fmt$(row.matCost) +
          '</td><td class="num">' + fmt$(row.matRetail) +
          '</td><td class="num">' + numInput(row, "hrs") +
          '</td><td class="num">' + fmt$(row.labour) + "</td></tr>";
      });
    }

    // ── Cable section: unchanged ──────────────────────────────────────────
    function sectionCables() {
      var list = rows.filter(function (r) { return r.kind === "cab"; });
      html += '<tr class="group-head"><td colspan="6">Cable / runs (length incl. drops + wastage)</td></tr>';
      if (!list.length) { html += '<tr><td colspan="6" style="color:var(--faint)">No lines drawn</td></tr>'; return; }
      list.forEach(function (row) {
        matCost += row.matCost; matRetail += row.matRetail; totHrs += row.effHrs;
        var part = row.part;
        var edited = (row.qtyOv || row.hrsOv)
          ? ' <a href="#" class="layer-part" data-reset-kind="' + row.kind + '" data-reset-id="' + escapeHtml(row.id) + '" title="Reset to auto">↺</a>' : "";
        html += "<tr><td>" +
          (row.color ? "<span class='layer-swatch' style='display:inline-block;background:" + row.color + ";width:10px;height:10px;border-radius:2px;margin-right:5px'></span>" : "") +
          escapeHtml(row.name) +
          (part ? '<br><span class="layer-part">' + escapeHtml(part.part_no) + "</span>" : ' <a href="#" class="unlinked" data-lay="' + escapeHtml(row.id) + '">link part</a>') +
          (row.meta ? '<br><span class="layer-meta">' + escapeHtml(row.meta) + "</span>" : "") + edited +
          '</td><td class="num">' + numInput(row, "qty") +
          '</td><td class="num">' + fmt$(row.matCost) + '</td><td class="num">' + fmt$(row.matRetail) +
          '</td><td class="num">' + numInput(row, "hrs") + '</td><td class="num">' + fmt$(row.labour) + "</td></tr>";
      });
    }

    sectionDevices();
    sectionCables();

    var totLabour = totHrs * rate;
    html += '</tbody><tfoot><tr><td>SUBTOTAL</td><td></td><td class="num">' + fmt$(matCost) + '</td><td class="num">' + fmt$(matRetail) +
      '</td><td class="num">' + totHrs.toFixed(2) + '</td><td class="num">' + fmt$(totLabour) + '</td></tr></tfoot></table>';

    var estCost = matCost + totLabour, quote = matRetail + totLabour, margin = quote - estCost;
    html += '<div style="margin-top:12px;border-top:2px solid var(--border-strong);padding-top:10px">';
    html += '<div class="totals-row"><span>Material cost</span><span>' + fmt$(matCost) + '</span></div>';
    html += '<div class="totals-row"><span>Material retail</span><span>' + fmt$(matRetail) + '</span></div>';
    html += '<div class="totals-row"><span>Labour (' + totHrs.toFixed(2) + ' h @ ' + fmt$(rate) + ')</span><span>' + fmt$(totLabour) + '</span></div>';
    html += '<div class="totals-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px"><span>Estimated cost</span><span>' + fmt$(estCost) + '</span></div>';
    html += '<div class="totals-row"><span style="color:var(--text)">Quote (retail + labour)</span><span class="big" style="color:var(--text)">' + fmt$(quote) + '</span></div>';
    html += '<div class="totals-row"><span>Margin</span><span class="big">' + fmt$(margin) + (quote ? '  (' + (margin / quote * 100).toFixed(1) + '%)' : "") + '</span></div>';
    html += '</div>';
    html += '<button class="btn" id="csvBtn" style="width:100%;justify-content:center;margin-top:10px">⇩ Export takeoff CSV</button>';
    html += '<button class="btn primary" id="quoteBtn" style="width:100%;justify-content:center;margin-top:8px">🧾 Printable quote</button>';

    var box = $("tab-takeoff"); box.innerHTML = html;
    $("wasteInp").onchange = function () { state.wastagePct = parseFloat(this.value) || 0; refreshTakeoff(); };
    $("rateInp").onchange = function () { state.labourRate = parseFloat(this.value) || 0; refreshTakeoff(); };
    $("csvBtn").onclick = exportCsv;
    $("quoteBtn").onclick = openQuoteModal;
    box.querySelectorAll(".ta-num").forEach(function (inp) {
      inp.onchange = function () {
        var v = this.value.trim() === "" ? null : parseFloat(this.value);
        setOverride(this.dataset.kind, this.dataset.id, this.dataset.k === "qty" ? "qtyOverride" : "hrsOverride", v);
        refreshTakeoff();
      };
    });
    box.querySelectorAll("[data-reset-id]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        setOverride(a.dataset.resetKind, a.dataset.resetId, "qtyOverride", null);
        setOverride(a.dataset.resetKind, a.dataset.resetId, "hrsOverride", null);
        refreshTakeoff();
      };
    });
    box.querySelectorAll("[data-sym]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openAssign("symbol", a.dataset.sym); }; });
    box.querySelectorAll("[data-lay]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); openAssign("layer", a.dataset.lay); }; });
  }
  function exportCsv() {
    var data = takeoffRows(), rate = data.rate;
    var rows = [["Section", "Part No", "Description", "Symbol", "Qty", "Edited", "Unit cost", "Unit retail",
      "Material cost", "Material retail", "Labour hrs", "Labour rate", "Labour $"]];
    var matCost = 0, matRetail = 0, totHrs = 0;
    data.rows.forEach(function (row) {
      var part = row.part || {};
      matCost += row.matCost; matRetail += row.matRetail; totHrs += row.effHrs;
      rows.push([row.kind === "dev" ? "Device" : "Cable", part.part_no || "(unlinked)", part.description || "", row.name,
        row.kind === "cab" ? row.effQty.toFixed(2) : row.effQty, (row.qtyOv || row.hrsOv) ? "yes" : "",
        part.cost || "", part.retail || "", row.matCost.toFixed(2), row.matRetail.toFixed(2),
        row.effHrs.toFixed(2), rate, row.labour.toFixed(2)]);
    });
    var totLabour = totHrs * rate;
    rows.push([]);
    rows.push(["", "", "", "", "", "", "", "", "Material cost", matCost.toFixed(2)]);
    rows.push(["", "", "", "", "", "", "", "", "Material retail", matRetail.toFixed(2)]);
    rows.push(["", "", "", "", "", "", "", "", "Labour", totLabour.toFixed(2)]);
    rows.push(["", "", "", "", "", "", "", "", "Estimated cost", (matCost + totLabour).toFixed(2)]);
    rows.push(["", "", "", "", "", "", "", "", "Quote (retail+labour)", (matRetail + totLabour).toFixed(2)]);
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (state.name || "takeoff") + ".csv"; a.click();
  }

  // ------------- printable quote -------------
  function openQuoteModal() {
    var q = state.quoteInfo || {};
    $("qBusiness").value = q.business || "";
    $("qNumber").value = q.quoteNo || "";
    $("qDetails").value = q.details || "";
    $("qClient").value = q.client || "";
    $("qTax").value = (q.taxRate != null ? q.taxRate : 10);
    $("qPrices").value = q.prices || "retail";
    $("qNotes").value = q.notes != null ? q.notes : "Prices valid for 30 days. E&OE.";
    openModal("modalQuote");
  }
  function generateQuote() {
    state.quoteInfo = {
      business: $("qBusiness").value.trim(), details: $("qDetails").value.trim(),
      client: $("qClient").value.trim(), quoteNo: $("qNumber").value.trim(),
      taxRate: parseFloat($("qTax").value) || 0, prices: $("qPrices").value,
      notes: $("qNotes").value.trim(),
    };
    var q = state.quoteInfo, useCost = q.prices === "cost";
    var data = takeoffRows(), rate = data.rate;
    var rowsHtml = "", materials = 0, totHrs = 0;
    data.rows.forEach(function (row) {
      if (!(row.effQty > 0 || row.matRetail > 0 || row.matCost > 0)) return;
      var unitPrice = row.part ? (useCost ? row.part.cost : row.part.retail) : 0;
      var amount = useCost ? row.matCost : row.matRetail;
      materials += amount; totHrs += row.effHrs;
      var qtyStr = row.unit === "m" ? row.effQty.toFixed(2) + " m" : row.effQty + " ea";
      var desc = (row.part && row.part.description) ? row.part.description : row.name;
      var pn = row.part ? row.part.part_no : '<span style="color:#b00">— no part linked —</span>';
      rowsHtml += "<tr><td>" + esc(desc) + "</td><td class='c'>" + esc(pn) + "</td><td class='r'>" + qtyStr +
        "</td><td class='r'>" + money(unitPrice) + "</td><td class='r'>" + money(amount) + "</td></tr>";
    });
    var labour = totHrs * rate;
    var subtotal = materials + labour;
    var tax = subtotal * (q.taxRate / 100);
    var total = subtotal + tax;

    function money(v) { return "$" + (v || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
    var today = new Date().toLocaleDateString();
    var sheetsTxt = state.sheets.length + " sheet" + (state.sheets.length === 1 ? "" : "s");

    var doc = '<!doctype html><html><head><meta charset="utf-8"><title>Quote ' + esc(q.quoteNo || "") + '</title>' +
      '<style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:40px;font-size:13px}' +
      '.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #d9962a;padding-bottom:16px}' +
      '.biz{font-size:20px;font-weight:700}.muted{color:#666;font-size:12px;margin-top:4px;max-width:340px}' +
      '.qbox{text-align:right}.qbox h1{margin:0;font-size:26px;letter-spacing:3px;color:#d9962a}' +
      '.meta{margin:18px 0;display:flex;justify-content:space-between}.meta div{font-size:12px}.meta b{display:block;color:#666;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:1px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e3e3e3}' +
      'th{background:#f4f4f4;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#555}' +
      'td.r,th.r{text-align:right}td.c,th.c{font-family:monospace;font-size:11px;color:#555}' +
      '.sec td{background:#faf3e6;font-weight:700;color:#a8741f;text-transform:uppercase;font-size:11px;letter-spacing:.5px}' +
      '.tot{margin-top:14px;margin-left:auto;width:280px}.tot div{display:flex;justify-content:space-between;padding:5px 2px}' +
      '.tot .g{border-top:2px solid #1a1a1a;font-size:17px;font-weight:700;margin-top:4px;padding-top:8px}' +
      '.notes{margin-top:28px;color:#555;font-size:12px;border-top:1px solid #e3e3e3;padding-top:12px}' +
      '.pbar{margin-bottom:18px}.pbar button{background:#d9962a;color:#fff;border:0;padding:9px 18px;border-radius:6px;font-size:14px;cursor:pointer}' +
      '@media print{.pbar{display:none}body{padding:0}}' +
      '</style></head><body>' +
      '<div class="pbar"><button onclick="window.print()">Print / Save as PDF</button></div>' +
      '<div class="top"><div><div class="biz">' + (esc(q.business) || "Your Business") + '</div><div class="muted">' + esc(q.details) + '</div></div>' +
      '<div class="qbox"><h1>QUOTE</h1><div class="muted">' + (q.quoteNo ? "No. " + esc(q.quoteNo) + "<br>" : "") + today + '</div></div></div>' +
      '<div class="meta"><div><b>Bill to</b>' + (esc(q.client) || "—") + '</div><div><b>Project</b>' + (esc(state.name) || "Untitled") + '</div><div><b>Scope</b>' + sheetsTxt + '</div></div>' +
      '<table><thead><tr><th>Description</th><th class="c">Part</th><th class="r">Qty</th><th class="r">Unit ' + (useCost ? "cost" : "price") + '</th><th class="r">Amount</th></tr></thead><tbody>' +
      '<tr class="sec"><td colspan="5">Materials &amp; equipment</td></tr>' +
      (rowsHtml || '<tr><td colspan="5" style="color:#999">No items</td></tr>') +
      '<tr class="sec"><td colspan="5">Labour</td></tr>' +
      '<tr><td>Installation labour</td><td class="c"></td><td class="r">' + totHrs.toFixed(2) + ' h</td><td class="r">' + money(rate) + '</td><td class="r">' + money(labour) + '</td></tr>' +
      '</tbody></table>' +
      '<div class="tot"><div><span>Subtotal</span><span>' + money(subtotal) + '</span></div>' +
      '<div><span>Tax / GST (' + q.taxRate + '%)</span><span>' + money(tax) + '</span></div>' +
      '<div class="g"><span>Total</span><span>' + money(total) + '</span></div></div>' +
      (q.notes ? '<div class="notes">' + esc(q.notes) + '</div>' : "") +
      '</body></html>';

    var w = window.open("", "_blank");
    if (!w) { toast("Pop-up blocked — allow pop-ups to open the quote", true); return; }
    w.document.open(); w.document.write(doc); w.document.close(); w.focus();
    closeModal("modalQuote");
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  }
  function saveProject() {
    state.name = $("projName").value.trim() || "Untitled";
    fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: state.name, data: state }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.error) throw new Error(j.error); toast('Saved "' + j.name + '"'); })
      .catch(function (e) { toast("Save failed: " + e.message, true); });
  }
  function openProjectList() {
    openModal("modalOpen"); var box = $("projList"); box.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
    fetch("/api/projects").then(function (r) { return r.json(); }).then(function (j) {
      if (!j.projects || !j.projects.length) { box.innerHTML = '<p style="color:var(--muted)">No saved projects yet.</p>'; return; }
      box.innerHTML = "";
      j.projects.forEach(function (p) {
        var d = document.createElement("div"); d.className = "proj-list-item";
        d.style.cssText = "display:flex;align-items:center;gap:8px";
        var info = document.createElement("div");
        info.style.cssText = "flex:1;cursor:pointer;min-width:0";
        info.innerHTML = "<span>" + escapeHtml(p.name) + '</span><span class="when">' + new Date(p.modified * 1000).toLocaleString() + "</span>";
        info.onclick = function () { loadProject(p.name); };
        var delBtn = document.createElement("button");
        delBtn.textContent = "🗑";
        delBtn.title = "Delete project";
        delBtn.style.cssText = "background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--red,#f87171);cursor:pointer;font-size:14px;padding:3px 7px;flex-shrink:0";
        delBtn.onclick = function (e) {
          e.stopPropagation();
          if (!confirm('Delete project "' + p.name + '"? This cannot be undone.')) return;
          fetch("/api/projects/" + encodeURIComponent(p.name), { method: "DELETE" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j.error) { toast("Delete failed: " + j.error, true); return; }
              toast('Deleted "' + p.name + '"');
              d.remove();
              if (!box.children.length) box.innerHTML = '<p style="color:var(--muted)">No saved projects yet.</p>';
            });
        };
        d.appendChild(info);
        d.appendChild(delBtn);
        box.appendChild(d);
      });
    }).catch(function (e) { box.innerHTML = '<p class="unlinked">' + escapeHtml(e.message) + "</p>"; });
  }
  // Fetch global symbols from DB and merge into state.customSymbols
  function mergeDbSymbols() {
    fetch("/api/symbols").then(function (r) { return r.json(); }).then(function (data) {
      var syms = data.symbols || [];
      if (!syms.length) return;
      state.customSymbols = state.customSymbols || [];
      syms.forEach(function (sym) {
        var idx = state.customSymbols.findIndex(function (s) { return s.id === sym.id; });
        if (idx === -1) { state.customSymbols.push(sym); ensureSymbolImage(sym.id); }
        else { state.customSymbols[idx] = sym; delete symbolImages[sym.id]; ensureSymbolImage(sym.id); }
      });
      renderPalette();
    }).catch(function () {});
  }
  window.mergeDbSymbols = mergeDbSymbols;

  // Fetch packages from DB and merge into state.customParts (DB wins on part_no conflict)
  function mergeDbPackages() {
    fetch("/api/packages").then(function (r) { return r.json(); }).then(function (data) {
      var pkgs = data.packages || [];
      if (!pkgs.length) return;
      state.customParts = state.customParts || [];
      pkgs.forEach(function (pkg) {
        if (!state.customParts.find(function (p) { return p.part_no === pkg.part_no && p.isPackage; })) {
          state.customParts.push(pkg);
        } else {
          // Update in-place so any changes to the package propagate
          var idx = state.customParts.findIndex(function (p) { return p.part_no === pkg.part_no && p.isPackage; });
          if (idx !== -1) state.customParts[idx] = pkg;
        }
      });
      if (window.refreshTakeoff) window.refreshTakeoff();
    }).catch(function () {});
  }
  window.mergeDbPackages = mergeDbPackages;

  function loadProject(name) {
    fetch("/api/projects/" + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      state = Object.assign(newState(), j.data || {});
      state.symbolTypes = state.symbolTypes || {}; state.layers = state.layers || []; state.sheets = state.sheets || [];
      state.customSymbols = state.customSymbols || []; state.customParts = state.customParts || [];
      state.quoteInfo = state.quoteInfo || newState().quoteInfo;
      state.circuits  = state.circuits  || [];
      state.labelScale = state.labelScale != null ? state.labelScale : 0.4;
      state.labelColor = state.labelColor || "#e7edf5";
      symbolImages = {};
      preloadSymbols();
      if (!state.activeSheetId && state.sheets[0]) state.activeSheetId = state.sheets[0].id;
      if (!state.activeLayerId && state.layers[0]) state.activeLayerId = state.layers[0].id;
      $("projName").value = state.name || "";
      window._appState = state;
      _undoStack = []; _redoStack = []; updateUndoButtons();
      closeModal("modalOpen"); renderPalette(); renderSheets(); renderLayers(); renderActiveSheet(); refreshTakeoff();
      if (window.renderCircuitsTable) renderCircuitsTable();
      mergeDbPackages(); mergeDbSymbols();
      // Record this as the last-open project so page refresh restores it
      fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: state.name, data: state }) }).catch(function () {});
      toast('Opened "' + name + '"');
    }).catch(function (e) { toast("Open failed: " + e.message, true); });
  }
  function newProject() {
    if (state && (state.sheets.length || state.layers.length) && !confirm("Start a new project? Unsaved changes will be lost.")) return;
    state = newState(); addLayer("Power"); $("projName").value = "";
    _undoStack = []; _redoStack = []; updateUndoButtons();
    window._appState = state;
    renderPalette(); renderSheets(); renderLayers(); renderActiveSheet(); refreshTakeoff();
    if (window.renderCircuitsTable) renderCircuitsTable();
    mergeDbPackages(); mergeDbSymbols();
  }

  // ------------- settings -------------
  function openSettings() {
    openModal("modalSettings"); $("settingsMsg").innerHTML = "";
    // Populate label style controls from state
    var ls = (state && state.labelScale != null) ? state.labelScale : 0.4;
    var lc = (state && state.labelColor) ? state.labelColor : "#e7edf5";
    $("glbLabelScale").value = ls;
    $("glbLabelScaleVal").textContent = Math.round(ls * 100) + "%";
    $("glbLabelColor").value = lc;
    // Wire live updates
    $("glbLabelScale").oninput = function () {
      var n = Math.max(0.1, Math.min(2.0, parseFloat(this.value) || 0.4));
      state.labelScale = n;
      $("glbLabelScaleVal").textContent = Math.round(n * 100) + "%";
      if (window.syncAllRefLabels) window.syncAllRefLabels();
    };
    $("glbLabelColor").oninput = $("glbLabelColor").onchange = function () {
      state.labelColor = this.value;
      if (window.syncAllRefLabels) window.syncAllRefLabels();
    };
    $("glbLabelColorReset").onclick = function () {
      state.labelColor = "#e7edf5";
      $("glbLabelColor").value = "#e7edf5";
      if (window.syncAllRefLabels) window.syncAllRefLabels();
    };
    fetch("/api/settings").then(function (r) { return r.json(); }).then(function (c) {
      $("dbPath").value = c.dbPath || ""; $("dbTable").value = c.table || "";
      var col = c.columns || {};
      $("colPart").value = col.part_no || ""; $("colDesc").value = col.description || "";
      $("colCost").value = col.cost || ""; $("colRetail").value = col.retail || "";
      $("colUnit").value = col.unit || ""; $("colCat").value = col.category || "";
      $("colLabour").value = col.labour || "";
    });
  }
  function saveSettings() {
    var body = { dbPath: $("dbPath").value.trim(), table: $("dbTable").value.trim() || "parts",
      columns: { part_no: $("colPart").value.trim(), description: $("colDesc").value.trim(),
        cost: $("colCost").value.trim(), retail: $("colRetail").value.trim(),
        unit: $("colUnit").value.trim(), category: $("colCat").value.trim(),
        labour: $("colLabour").value.trim() } };
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) {
        var m = $("settingsMsg");
        if (!j.dbExists) m.innerHTML = '<div class="status-msg err">File not found on the server at that path.</div>';
        else if (j.valid === false) m.innerHTML = '<div class="status-msg err">' + escapeHtml(j.warning || "Could not read parts") + "</div>";
        else { m.innerHTML = '<div class="status-msg ok">Connected — parts database is readable.</div>'; renderPartsLibrary($("partsSearch").value); }
      }).catch(function (e) { $("settingsMsg").innerHTML = '<div class="status-msg err">' + escapeHtml(e.message) + "</div>"; });
  }

  // ------------- custom symbols -------------
  // openSymbolModal(id) → edit mode; openSymbolModal() → add mode
  function openSymbolModal(editId) {
    var existing = editId ? (customSymbol(editId) || LIB.byId[editId]) : null;
    $("symEditId").value = editId || "";
    $("symName").value  = existing ? existing.name : "";
    $("symCat").value   = existing ? existing.category : "electrical";
    $("symImg").value   = "";
    $("symPreview").innerHTML = existing
      ? '<img src="' + symImageURL(editId) + '" style="width:40px;height:40px;border:1px solid var(--border);border-radius:8px;background:#10151d">'
      : "";
    $("symbolMsg").innerHTML = "";
    // Modal title and buttons
    $("symbolModalTitle").textContent = existing ? "Edit symbol" : "Add custom symbol";
    $("symbolSave").textContent = existing ? "Save changes" : "Add symbol";
    // Delete button: only show for custom symbols (not built-ins)
    var editSym = editId ? customSymbol(editId) : null;
    var isCustom = editId && !!(editSym || (existing && existing.custom));
    $("symbolDelete").style.display = isCustom ? "inline-flex" : "none";
    $("symbolDelete").onclick = function () { closeModal("modalSymbol"); deleteCustomSymbol(editId); };
    // Image field hint: different for edit vs add
    var hint = $("symImgField").querySelector(".hint");
    if (hint) hint.textContent = existing
      ? "Leave blank to keep the current image, or upload a new one to replace it."
      : "Leave blank and a labelled badge is auto-generated.";
    openModal("modalSymbol");
    setTimeout(function () { $("symName").focus(); $("symName").select(); }, 50);
  }
  function previewSymbol() {
    var f = $("symImg").files[0];
    if (!f) { $("symPreview").innerHTML = ""; return; }
    var r = new FileReader();
    r.onload = function () { $("symPreview").innerHTML = '<img src="' + r.result + '" style="width:40px;height:40px;border:1px solid var(--border);border-radius:8px;background:#10151d">'; };
    r.readAsDataURL(f);
  }
  function symbolSave() {
    var name = $("symName").value.trim();
    if (!name) { $("symbolMsg").innerHTML = '<div class="status-msg err">Enter a name.</div>'; return; }
    var cat     = $("symCat").value;
    var f       = $("symImg").files[0];
    var editId  = $("symEditId").value;
    var existing = editId ? customSymbol(editId) : null;

    function persistSymbol(sym) {
      fetch("/api/symbols", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sym) }).catch(function () {});
    }

    function applyEdit(dataURL) {
      if (existing) {
        // Update existing custom symbol in-place
        existing.name     = name;
        existing.category = cat;
        if (dataURL) {
          existing.dataURL = dataURL;
          delete symbolImages[editId];
          ensureSymbolImage(editId);
        }
        // Re-render any placed instances so their images update
        if (sheet()) {
          sheet().symbols.forEach(function (s) {
            if (s.type === editId && symbolNodes[s.id]) {
              symbolNodes[s.id].image(symbolImages[editId]);
            }
          });
          shapeLayer && shapeLayer.batchDraw();
        }
        persistSymbol(existing);
        closeModal("modalSymbol"); renderPalette(); refreshTakeoff();
        toast('Symbol "' + name + '" updated');
      } else if (editId) {
        // Editing a built-in: save as a custom override with the same id
        // (so existing placements still work)
        state.customSymbols = state.customSymbols || [];
        var override = customSymbol(editId);
        if (override) {
          override.name = name; override.category = cat;
          if (dataURL) { override.dataURL = dataURL; delete symbolImages[editId]; ensureSymbolImage(editId); }
          persistSymbol(override);
        } else {
          var s = { id: editId, name: name, category: cat,
                    dataURL: dataURL || symImageURL(editId), custom: true };
          state.customSymbols.push(s);
          delete symbolImages[editId]; ensureSymbolImage(editId);
          persistSymbol(s);
        }
        closeModal("modalSymbol"); renderPalette(); refreshTakeoff();
        toast('Symbol "' + name + '" updated');
      } else {
        // Add new
        var s = { id: uid("csym"), name: name, category: cat, dataURL: dataURL, custom: true };
        state.customSymbols = state.customSymbols || [];
        state.customSymbols.push(s);
        delete symbolImages[s.id]; ensureSymbolImage(s.id);
        persistSymbol(s);
        closeModal("modalSymbol"); renderPalette(); toast('Symbol "' + name + '" added');
      }
    }

    if (f) {
      var r = new FileReader();
      r.onload = function () { applyEdit(r.result); };
      r.readAsDataURL(f);
    } else {
      // No new file: keep existing image or generate badge for new symbols
      applyEdit(existing ? null : buildLabelSymbol(name, cat));
    }
  }

  // ------------- custom parts -------------
  function openPartModal() {
    ["partNo", "partUnit", "partDesc", "partCost", "partRetail", "partLabour", "partCat"].forEach(function (id) { $(id).value = ""; });
    $("partMsg").innerHTML = "";
    openModal("modalPart"); setTimeout(function () { $("partNo").focus(); }, 50);
  }
  function partSave() {
    var pn = $("partNo").value.trim(), desc = $("partDesc").value.trim();
    if (!pn || !desc) { $("partMsg").innerHTML = '<div class="status-msg err">Part number and description are required.</div>'; return; }
    var p = { part_no: pn, description: desc, unit: $("partUnit").value.trim(),
      cost: parseFloat($("partCost").value) || 0, retail: parseFloat($("partRetail").value) || 0,
      labour: parseFloat($("partLabour").value) || 0, category: $("partCat").value.trim(), _custom: true };
    state.customParts = state.customParts || [];
    // replace if same part_no already custom
    state.customParts = state.customParts.filter(function (x) { return x.part_no !== pn; });
    state.customParts.push(p);
    // Persist to DB immediately (INSERT OR REPLACE)
    fetch("/api/parts", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ part_no: pn, description: p.description, cost: p.cost, retail: p.retail, category: p.category, unit: p.unit })
    }).catch(function () {}); // fire-and-forget; project save is the fallback
    closeModal("modalPart"); toast('Part "' + pn + '" saved');
    if ($("modalAssign").classList.contains("open")) renderAssignResults($("assignSearch").value);
    else renderPartsLibrary($("partsSearch").value);
  }

  // ------------- modals / toast -------------
  function openModal(id) { $(id).classList.add("open"); }
  function closeModal(id) { $(id).classList.remove("open"); }
  window.openModal  = openModal;
  window.closeModal = closeModal;
  var toastTimer;
  function toast(msg, err) {
    var t = $("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "toast"; }, 2600);
  }

  // ------------- wire up -------------
  function debounce(fn, ms) { var to; return function () { var a = arguments, c = this; clearTimeout(to); to = setTimeout(function () { fn.apply(c, a); }, ms); }; }

  function showFatal(msg) {
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(14,18,25,0.97);color:#e7edf5;font-family:system-ui,sans-serif;padding:30px;text-align:center";
    d.innerHTML = "<div style='max-width:560px'><h2 style='color:#ffb02e;margin:0 0 8px'>Couldn't start the app</h2>" +
      "<p>" + escapeHtml(msg) + "</p><p style='color:#8a98ab;font-size:13px'>This usually means the canvas/PDF libraries didn't load. " +
      "If this machine has no internet, run <code style='color:#38bdf8'>python3 fetch_vendor.py</code> on a machine with internet to download them into <code>static/vendor/</code>, then reload.</p></div>";
    document.body.appendChild(d);
  }

  function init() {
    // 1) Wire all DOM handlers FIRST so the UI works even if the canvas fails.
    document.querySelectorAll(".tool").forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    $("addLayer").onclick = function () { addLayer(); };
    $("showAllLayers").onclick = function () {
      state.layers.forEach(function (l) { l.visible = true; applyLayerVisibility(l); });
      renderLayers();
    };
    $("hideAllLayers").onclick = function () {
      state.layers.forEach(function (l) { l.visible = false; applyLayerVisibility(l); });
      renderLayers();
    };
    $("addSheet").onclick = function () { $("fileInput").click(); };
    $("fileInput").onchange = function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; };
    $("dropZone").onclick = function () { $("fileInput").click(); };

    var wrap = $("canvas-wrap");
    ["dragover", "dragenter"].forEach(function (ev) { wrap.addEventListener(ev, function (e) { e.preventDefault(); }); });
    wrap.addEventListener("drop", function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

    $("zoomIn").onclick = function () { zoomBy(1.2); };
    $("zoomOut").onclick = function () { zoomBy(1 / 1.2); };
    $("zoomFit").onclick = fitView;

    $("btnNew").onclick = newProject;
    $("btnOpen").onclick = openProjectList;
    $("btnSave").onclick = saveProject;
    // Undo / Redo buttons
    var btnUndo = $("btnUndo"), btnRedo = $("btnRedo");
    if (btnUndo) { btnUndo.onclick = undoAction; btnUndo.disabled = true; }
    if (btnRedo) { btnRedo.onclick = redoAction; btnRedo.disabled = true; }
    window.pushUndo = pushUndo;
    window.updateUndoButtons = updateUndoButtons;
    $("openCancel").onclick = function () { closeModal("modalOpen"); };

    $("btnSettings").onclick = openSettings;
    $("settingsCancel").onclick = function () { closeModal("modalSettings"); };
    $("settingsSave").onclick = saveSettings;

    $("scaleCancel").onclick = function () { closeModal("modalScale"); };
    $("scaleApply").onclick = applyScale;

    $("assignCancel").onclick = function () { closeModal("modalAssign"); };
    $("assignClear").onclick = clearAssign;
    $("assignSave").onclick = assignSave;
    $("assignSearch").oninput = debounce(function () { renderAssignResults(this.value); }, 250);

    $("btnTakeoff").onclick = function () { $("app").classList.toggle("right-open"); };

    // ── Circuits drawer toggle + drag-to-resize ───────────────────────
    (function () {
      var drawer  = $("circuitsDrawer");
      var handle  = $("circuitsDrawerHandle");
      var btn     = $("btnCircuits");
      var STORAGE_KEY = "circuitsDrawerH";

      var savedH = parseInt(localStorage.getItem(STORAGE_KEY)) || 320;
      drawer.style.setProperty("--drawer-h", savedH + "px");

      function setOpen(open) {
        drawer.classList.toggle("open", open);
        btn.classList.toggle("active", open);
        localStorage.setItem("circuitsDrawerOpen", open ? "1" : "0");
        if (open && window.renderCircuitsTable) window.renderCircuitsTable();
      }

      if (localStorage.getItem("circuitsDrawerOpen") === "1") setOpen(true);
      btn.onclick = function () { setOpen(!drawer.classList.contains("open")); };

      var dragging = false, startY = 0, startH = 0;
      handle.addEventListener("mousedown", function (e) {
        if (!drawer.classList.contains("open")) return;
        dragging = true; startY = e.clientY;
        startH = drawer.getBoundingClientRect().height;
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        var delta = startY - e.clientY;
        var maxH  = window.innerHeight - 54 - 30 - 60;
        var newH  = Math.max(120, Math.min(maxH, startH + delta));
        drawer.style.setProperty("--drawer-h", newH + "px");
        localStorage.setItem(STORAGE_KEY, Math.round(newH));
      });
      document.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      });

      window.circuitsDrawerSetOpen = setOpen;
    })();

    document.querySelectorAll(".tab").forEach(function (t) {
      t.onclick = function () {
        if (window.switchTab) { window.switchTab(t.dataset.tab); return; }
        // fallback for before module loads
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        $("tab-takeoff").style.display = t.dataset.tab === "takeoff" ? "block" : "none";
        $("tab-parts").style.display   = t.dataset.tab === "parts"   ? "block" : "none";
        if (t.dataset.tab === "parts") renderPartsLibrary($("partsSearch").value);
      };
    });
    $("partsSearch").oninput = debounce(function () { renderPartsLibrary(this.value); }, 250);

    $("addSymbol").onclick = function () { openSymbolModal(); };
    $("symbolCancel").onclick = function () { closeModal("modalSymbol"); };
    $("symbolSave").onclick = symbolSave;
    $("symImg").onchange = previewSymbol;
    $("addPart").onclick = openPartModal;
    $("partCancel").onclick = function () { closeModal("modalPart"); };
    $("partSave").onclick = partSave;
    $("quoteCancel").onclick = function () { closeModal("modalQuote"); };
    $("quoteGen").onclick = generateQuote;
    $("symSize").oninput = function () {
      newSymbolSize = parseInt(this.value, 10) || 30;
      $("symSizeVal").textContent = newSymbolSize;
      resizeSelectedSymbol(newSymbolSize);
    };

    document.addEventListener("keydown", function (e) {
      // Undo/redo — intercept before the input guard so Ctrl+Z works everywhere
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undoAction(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redoAction(); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); redoAction(); return; }
      if (/input|select|textarea/i.test((e.target.tagName || ""))) return;
      if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "c" || e.key === "C") setTool("calibrate");
      else if (e.key === "s" || e.key === "S") setTool("symbol");
      else if (e.key === "l" || e.key === "L") setTool("line");
      else if (e.key === "r" || e.key === "R") setTool("route");
      else if (e.key === "t" || e.key === "T") setTool("text");
      else if (e.key === "m" || e.key === "M") setTool("measure");
      else if (e.key === "Enter" && (tool === "line" || tool === "route") && draftPoints) finishCurrent();
      else if (e.key === "Escape") { cancelDraft(); deselect(); ["modalScale", "modalSettings", "modalOpen", "modalAssign", "modalSymbol", "modalPart", "modalQuote", "modalExportPDF", "modalManualItem", "modalPackage", "modalRenameLayer"].forEach(closeModal); }
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
      else if (e.key === " " && stage) { spaceDown = true; stage.draggable(true); stage.container().style.cursor = "grab"; }
    });
    document.addEventListener("keyup", function (e) { if (e.key === " " && stage) { spaceDown = false; setTool(tool); } });
    document.querySelectorAll(".modal-back").forEach(function (mb) { mb.addEventListener("click", function (e) { if (e.target === mb) mb.classList.remove("open"); }); });
    $("app").classList.add("right-open");

    // 2) Start the canvas + initial state (guarded).
    try {
      if (typeof Konva === "undefined") throw new Error("The canvas library (Konva) did not load.");
      if (window.__PDF_WORKER__ && window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = window.__PDF_WORKER__;
      state = newState();                 // must exist before preloadSymbols/renderPalette read it
      initStage();
      preloadSymbols(); renderPalette();
      addLayer("Power"); $("projName").value = "";
      renderSheets(); renderLayers(); renderActiveSheet(); refreshTakeoff(); updateScaleStatus();
      // Expose internals for the properties/circuits module
      window._appState      = state;
      window.symbolNodes    = symbolNodes;
      window.refLabelNodes  = refLabelNodes;
      window.shapeLayer     = shapeLayer;
      window.deleteSelected = deleteSelected;
      window.searchParts    = searchParts;
      window.debounce       = debounce;
      window.routeNodes     = routeNodes;
      window.textNodes      = textNodes;
      window.syncRefLabel      = syncRefLabel;
      window.syncAllRefLabels  = syncAllRefLabels;
      window.openAssign        = openAssign;
      window.refreshTakeoff    = refreshTakeoff;
      window.routeAutoCorners  = routeAutoCorners;
      // Auto-restore last open project on page load / refresh
      fetch("/api/session").then(function (r) { return r.json(); }).then(function (sess) {
        if (sess && sess.lastProject) {
          loadProject(sess.lastProject); // mergeDbPackages called inside loadProject
        } else {
          mergeDbPackages(); mergeDbSymbols();
        }
      }).catch(function () { mergeDbPackages(); mergeDbSymbols(); });
    } catch (e) {
      console.error(e);
      showFatal(e.message || String(e));
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // EXTEND init() – wire up new buttons after the existing init() runs
  // ─────────────────────────────────────────────────────────────────────
  var _origInit = init;
  init = function () {
    _origInit();

    // Feature: PDF export
    $("btnExportPDF").onclick = function () { openModal("modalExportPDF"); };
    $("pdfExportCancel").onclick = function () { closeModal("modalExportPDF"); };
    $("pdfExportGo").onclick = doExportPDF;

    // Feature: Manual takeoff items
    $("btnAddManualItem").onclick = function () { openManualItemModal(); };
    $("manualItemCancel").onclick = function () { closeModal("modalManualItem"); };
    $("manualItemSave").onclick = saveManualItem;

    // Feature: Packaged parts – open from parts tab
    $("btnCreatePackage").onclick = function () { openPackageModal(null); };
    $("pkgModalCancel").onclick = function () { closeModal("modalPackage"); };
    $("pkgModalSave").onclick = savePackage;
    $("pkgAddComponent").onclick = addPackageComponentRow;
    var pkgSearchInp = $("pkgSearch");
    if (pkgSearchInp) pkgSearchInp.oninput = debounce(function () { pkgSearchParts(pkgSearchInp.value); }, 300);

    // Extend escape key to close new modals
    var _origKeydown = null; // escape is handled via .modal-back click; already generic

    // Extend symbol palette with layer filter
    $("symLayerFilter").onchange = renderPalette;

    // Extend renderLayers to populate the layer filter
    var _origRenderLayers = renderLayers;
    renderLayers = function () {
      _origRenderLayers();
      populateLayerFilter();
    };

    // Extend openAssign to show layer affinity picker for symbols
    var _origOpenAssign = openAssign;
    openAssign = function (kind, key, instanceSym) {
      _origOpenAssign(kind, key, instanceSym);
      if (kind === "symbol") {
        populateSymLayerPicker();
        var cfg = state.symbolTypes[key] || {};
        $("symLayerPicker").value = cfg.palLayerId || "";
      }
    };
    window.openAssign = openAssign;  // keep window reference in sync with extended version

    // Extend assignSave to also persist palLayerId (only for type-level assignments)
    var _origAssignSave = assignSave;
    assignSave = function () {
      _origAssignSave();
      if (assignCtx && assignCtx.kind === "symbol" && !assignCtx.instanceSym) {
        var cfg = state.symbolTypes[assignCtx.key] || {};
        cfg.palLayerId = $("symLayerPicker").value || null;
        state.symbolTypes[assignCtx.key] = cfg;
        renderPalette();
      }
    };

    // Extend renderPalette to show layer groups and tags
    var _origRenderPalette = renderPalette;
    renderPalette = function () {
      _origRenderPalette();
      addLayerTagsToPalette();
    };

    // ── Task 2: Import parts from CSV ──────────────────────────────
    var btnImportParts = $("btnImportParts");
    if (btnImportParts) btnImportParts.onclick = function () {
      $("importPartsResult").innerHTML = "";
      $("importPartsFile").value = "";
      $("importPartsProgress").style.display = "none";
      $("importPartsBar").style.width = "0%";
      openModal("modalImportParts");
    };
    var importPartsCancel = $("importPartsCancel");
    if (importPartsCancel) importPartsCancel.onclick = function () { closeModal("modalImportParts"); };
    var importPartsGo = $("importPartsGo");
    if (importPartsGo) importPartsGo.onclick = function () {
      var f = $("importPartsFile").files[0];
      if (!f) { $("importPartsResult").innerHTML = '<span style="color:var(--red,#f87171)">Please select a CSV file first.</span>'; return; }
      var prog = $("importPartsProgress");
      var bar  = $("importPartsBar");
      var status = $("importPartsStatus");
      var result = $("importPartsResult");
      prog.style.display = "block";
      bar.style.width = "5%";
      status.textContent = "Uploading…";
      result.innerHTML = "";
      importPartsGo.disabled = true;
      var fd = new FormData();
      fd.append("file", f);
      fetch("/api/import-parts", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          importPartsGo.disabled = false;
          if (j.error) { result.innerHTML = '<span style="color:var(--red,#f87171)">Error: ' + escapeHtml(j.error) + '</span>'; bar.style.width = "0%"; return; }
          // Animate through progress checkpoints
          var steps = j.progress || [];
          var total = j.total || 1;
          function animSteps(i) {
            if (i < steps.length) {
              var s = steps[i];
              bar.style.width = Math.round(s.processed / total * 100) + "%";
              status.textContent = "Processing… " + s.processed + " / " + total;
              setTimeout(function () { animSteps(i + 1); }, 60);
            } else {
              bar.style.width = "100%";
              status.textContent = "Done!";
              result.innerHTML =
                '<span style="color:var(--green,#34d399)">✔ Import complete</span><br>' +
                '<span style="font-size:12px;color:var(--muted)">Added: <strong>' + j.added + '</strong> &nbsp; Updated: <strong>' + j.updated + '</strong> &nbsp; Skipped: <strong>' + j.skipped + '</strong> &nbsp; Total rows: <strong>' + j.total + '</strong></span>';
              renderPartsLibrary($("partsSearch").value);
              // Refresh editor if it's open
              if ($("modalPartsEditor").classList.contains("open")) {
                window.renderPartsEditor($("peSearch").value);
              }
            }
          }
          animSteps(0);
        })
        .catch(function (e) {
          importPartsGo.disabled = false;
          result.innerHTML = '<span style="color:var(--red,#f87171)">Network error: ' + escapeHtml(e.message) + '</span>';
        });
  

  };

    // ── Task 5: Parts database editor ──────────────────────────────
    var btnEditPartsDb = $("btnEditPartsDb");
    if (btnEditPartsDb) btnEditPartsDb.onclick = window.openPartsEditor;
    var peClose = $("peClose");
    if (peClose) peClose.onclick = function () { closeModal("modalPartsEditor"); };
    var peSearch = $("peSearch");
    if (peSearch) peSearch.oninput = debounce(function () { window.renderPartsEditor(peSearch.value); }, 250);
    var peAddRow = $("peAddRow");
    if (peAddRow) peAddRow.onclick = window.addPartsEditorRow;

    // ── Marquee multi-select ─────────────────────────────────────
    var marqueeActive = false, marqueeStart = null, marqueeIds = [];
    var marqueeEl  = document.getElementById("marqueeRect");
    var bannerEl   = document.getElementById("multiSelectBanner");
    var countEl    = document.getElementById("multiSelectCount");
    var pickerEl   = document.getElementById("multiLayerPicker");
    var applyBtn   = document.getElementById("multiLayerApply");
    var clearBtn   = document.getElementById("multiSelectClear");

    function openMultiBanner(ids) {
      marqueeIds = ids;
      countEl.textContent = ids.length + " symbol" + (ids.length !== 1 ? "s" : "") + " selected";
      pickerEl.innerHTML = "<option value=''>— not assigned —</option>";
      (state.layers || []).forEach(function (l) {
        var opt = document.createElement("option");
        opt.value = l.id; opt.textContent = l.name;
        pickerEl.appendChild(opt);
      });
      var existingLayers = ids.map(function (id) {
        var s = sheet().symbols.find(function (x) { return x.id === id; });
        return s ? (s.visibleLayerId || "") : "";
      });
      var allSame = existingLayers.every(function (v) { return v === existingLayers[0]; });
      pickerEl.value = allSame ? existingLayers[0] : "";
      bannerEl.classList.add("open");
      ids.forEach(function (id) {
        var n = symbolNodes[id];
        if (n) { n.shadowColor("#38bdf8"); n.shadowBlur(14); n.shadowOpacity(0.9); }
      });
      shapeLayer.batchDraw();
    }

    function closeMultiBanner() {
      bannerEl.classList.remove("open");
      marqueeIds.forEach(function (id) {
        var n = symbolNodes[id]; if (n) n.shadowBlur(0);
      });
      marqueeIds = [];
      shapeLayer.batchDraw();
    }

    if (applyBtn) applyBtn.onclick = function () {
      var layerId = pickerEl.value;
      pushUndo();
      marqueeIds.forEach(function (id) {
        var s = sheet().symbols.find(function (x) { return x.id === id; });
        if (s) s.visibleLayerId = layerId || null;
      });
      if (layerId) {
        var lay = state.layers.find(function (l) { return l.id === layerId; });
        if (lay) applyLayerVisibility(lay);
      }
      var count = marqueeIds.length;
      closeMultiBanner();
      refreshTakeoff(); renderLayers();
      toast(count + " symbol" + (count !== 1 ? "s" : "") + (layerId
        ? " moved to " + (state.layers.find(function(l){return l.id===layerId;})||{}).name
        : " unassigned from layer"));
    };

    if (clearBtn) clearBtn.onclick = closeMultiBanner;

    // Marquee rubber-band draw
    var canvasWrap = document.getElementById("canvas-wrap");

    function marqueeScreenPos(clientX, clientY) {
      var r = canvasWrap.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    }

    stage.on("mousedown.marquee", function (e) {
      if (tool !== "select" || spaceDown) return;
      if (e.target !== stage && e.target !== planNode) return;
      closeMultiBanner();
      var cx = e.evt.clientX, cy = e.evt.clientY;
      marqueeStart = marqueeScreenPos(cx, cy);
      marqueeActive = true;
      marqueeEl.style.left   = marqueeStart.x + "px";
      marqueeEl.style.top    = marqueeStart.y + "px";
      marqueeEl.style.width  = "0px";
      marqueeEl.style.height = "0px";
      marqueeEl.style.display = "block";
    });

    stage.on("mousemove.marquee", function (e) {
      if (!marqueeActive) return;
      var cur = marqueeScreenPos(e.evt.clientX, e.evt.clientY);
      marqueeEl.style.left   = Math.min(marqueeStart.x, cur.x) + "px";
      marqueeEl.style.top    = Math.min(marqueeStart.y, cur.y) + "px";
      marqueeEl.style.width  = Math.abs(cur.x - marqueeStart.x) + "px";
      marqueeEl.style.height = Math.abs(cur.y - marqueeStart.y) + "px";
    });

    stage.on("mouseup.marquee", function (e) {
      if (!marqueeActive) return;
      marqueeActive = false;
      marqueeEl.style.display = "none";
      var cur = marqueeScreenPos(e.evt.clientX, e.evt.clientY);
      var sw = Math.abs(cur.x - marqueeStart.x);
      var sh2 = Math.abs(cur.y - marqueeStart.y);
      if (sw < 6 || sh2 < 6) return;
      // Convert screen rect to world coords
      var sc = stage.scaleX();
      var ox = stage.x(), oy = stage.y();
      var x1 = (Math.min(marqueeStart.x, cur.x) - ox) / sc;
      var y1 = (Math.min(marqueeStart.y, cur.y) - oy) / sc;
      var x2 = (Math.max(marqueeStart.x, cur.x) - ox) / sc;
      var y2 = (Math.max(marqueeStart.y, cur.y) - oy) / sc;
      var sh = sheet(); if (!sh) return;
      var found = sh.symbols.filter(function (s) {
        return s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2;
      }).map(function (s) { return s.id; });
      if (found.length) openMultiBanner(found);
    });

    document.addEventListener("keydown.marquee", function (e) {
      if (e.key === "Escape" && marqueeIds.length) closeMultiBanner();
    });

  };

  // ── Parts editor — exposed on window so there are zero scope issues ──
  window.openPartsEditor = function () {
    var peSearch = document.getElementById("peSearch");
    var peMsg    = document.getElementById("peMsg");
    if (peSearch) peSearch.value = "";
    if (peMsg)    peMsg.textContent = "";
    openModal("modalPartsEditor");
    window.renderPartsEditor("");
  };

  window.renderPartsEditor = function (q) {
    var body  = document.getElementById("peTableBody");
    var empty = document.getElementById("peEmpty");
    var msg   = document.getElementById("peMsg");
    if (!body) { console.error("peTableBody not found"); return; }
    body.innerHTML = '<tr><td colspan="7" style="padding:12px;text-align:center;color:#8a98ab">Loading…</td></tr>';
    if (empty) empty.style.display = "none";
    if (msg)   msg.textContent = "";

    var limit = 500;
    var url = "/api/parts?q=" + encodeURIComponent(q || "") + "&limit=" + limit;

    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error);

        var dbParts = j.parts || [];
        // Merge custom parts from project state
        var st = window._appState;
        var custom = (st && st.customParts || []).filter(function (p) {
          if (!q) return true;
          var ql = q.toLowerCase();
          return ((p.part_no || "") + " " + (p.description || "") + " " + (p.category || "")).toLowerCase().indexOf(ql) !== -1;
        }).map(function (p) { return Object.assign({}, p, { _custom: true }); });

        var parts = custom.concat(dbParts);

        body.innerHTML = "";
        if (!parts.length) {
          if (empty) empty.style.display = "block";
          if (msg) msg.textContent = q ? "No parts match \"" + q + "\"" : "No parts in database.";
          return;
        }

        if (msg) msg.textContent = parts.length + " part" + (parts.length !== 1 ? "s" : "") +
          (parts.length >= limit ? " (first " + limit + " shown — search to narrow)" : "");

        parts.forEach(function (p) {
          var tr = document.createElement("tr");
          tr.style.cssText = "border-bottom:1px solid var(--border,#2e3a4a)";
          var isCustom = !!p._custom;

          // Helper: make a table cell
          function mkCell(val, rightAlign, editable, field) {
            var td = document.createElement("td");
            td.style.cssText = "padding:5px 8px;vertical-align:middle;" + (rightAlign ? "text-align:right;" : "");
            if (editable) {
              var inp = document.createElement("input");
              inp.type = "text";
              inp.value = (val == null) ? "" : String(val);
              inp.dataset.field = field;
              inp.style.cssText = "width:100%;background:transparent;border:none;border-bottom:1px solid transparent;color:var(--text,#e7edf5);font-size:12px;padding:2px 2px;min-width:40px;outline:none;";
              inp.onfocus = function () { inp.style.borderBottomColor = "var(--accent,#ffb02e)"; };
              inp.onblur  = function () {
                inp.style.borderBottomColor = "transparent";
                // Collect all fields from this row and save
                var data = {};
                tr.querySelectorAll("input[data-field]").forEach(function (el) { data[el.dataset.field] = el.value; });
                if (isCustom) {
                  var cp = window._appState && window._appState.customParts && window._appState.customParts.find(function (x) { return x.part_no === p.part_no; });
                  if (cp) { cp.description = data.description || ""; cp.cost = parseFloat(data.cost) || 0; cp.retail = parseFloat(data.retail) || 0; cp.category = data.category || ""; cp.unit = data.unit || ""; }
                } else {
                  fetch("/api/parts/" + encodeURIComponent(p.part_no), {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ description: data.description, cost: parseFloat(data.cost) || 0, retail: parseFloat(data.retail) || 0, category: data.category, unit: data.unit })
                  }).then(function (r) { return r.json(); }).then(function (j) {
                    if (j.error && msg) msg.textContent = "Save error: " + j.error;
                  });
                }
              };
              td.appendChild(inp);
            } else {
              td.textContent = (val == null) ? "" : String(val);
              td.style.color = "var(--muted,#8a98ab)";
              td.style.fontSize = "11px";
              if (isCustom) {
                var b = document.createElement("span");
                b.textContent = " ★";
                b.style.cssText = "color:var(--accent,#ffb02e);font-size:10px";
                b.title = "Custom part (stored in project)";
                td.appendChild(b);
              }
            }
            return td;
          }

          tr.appendChild(mkCell(p.part_no,     false, false, "part_no"));
          tr.appendChild(mkCell(p.description, false, true,  "description"));
          tr.appendChild(mkCell(p.cost   != null ? Number(p.cost).toFixed(2)   : "0.00", true, true, "cost"));
          tr.appendChild(mkCell(p.retail != null ? Number(p.retail).toFixed(2) : "0.00", true, true, "retail"));
          tr.appendChild(mkCell(p.category || "", false, true, "category"));
          tr.appendChild(mkCell(p.unit     || "", false, true, "unit"));

          // Delete cell
          var delTd = document.createElement("td");
          delTd.style.cssText = "padding:4px;text-align:center;vertical-align:middle;";
          var delBtn = document.createElement("button");
          delBtn.textContent = "✕";
          delBtn.style.cssText = "background:transparent;border:none;color:#f87171;cursor:pointer;font-size:12px;padding:2px 6px;";
          delBtn.title = "Delete part";
          // Use closure to capture part_no and row
          (function (partNo, row, custom) {
            delBtn.onclick = function () {
              if (!confirm('Delete "' + partNo + '"?')) return;
              if (custom) {
                var st = window._appState;
                if (st) st.customParts = (st.customParts || []).filter(function (x) { return x.part_no !== partNo; });
                // Delete from whichever DB table holds it (safe to call both)
                fetch("/api/packages/" + encodeURIComponent(partNo), { method: "DELETE" }).catch(function () {});
                fetch("/api/parts/" + encodeURIComponent(partNo), { method: "DELETE" }).catch(function () {});
              } else {
                fetch("/api/parts/" + encodeURIComponent(partNo), { method: "DELETE" })
                  .then(function (r) { return r.json(); })
                  .then(function (j) { if (j.error && msg) msg.textContent = "Delete error: " + j.error; });
              }
              row.remove();
              if (msg) msg.textContent = "Deleted " + partNo;
            };
          })(p.part_no, tr, isCustom);
          delTd.appendChild(delBtn);
          tr.appendChild(delTd);

          body.appendChild(tr);
        });
      })
      .catch(function (err) {
        body.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#f87171;">Error loading parts: ' + String(err) + '</td></tr>';
        console.error("Parts editor error:", err);
      });
  };

  window.addPartsEditorRow = function () {
    var pn   = prompt("New part number:");
    if (!pn || !pn.trim()) return;
    pn = pn.trim();
    var desc = prompt("Description:");
    if (desc === null) return;
    fetch("/api/parts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ part_no: pn, description: desc, cost: 0, retail: 0, category: "", unit: "" })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { alert("Error: " + j.error); return; }
        var q = document.getElementById("peSearch");
        window.renderPartsEditor(q ? q.value : "");
      });
  };


  // ── (parts editor functions moved to window.renderPartsEditor / window.openPartsEditor above) ──


  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 1 – PDF EXPORT (proper Konva async + jsPDF)
  // ─────────────────────────────────────────────────────────────────────
  function doExportPDF() {
    var JsPDF = (window.jspdf && window.jspdf.jsPDF) || (window.jsPDF && window.jsPDF.jsPDF);
    if (!JsPDF) { toast("PDF library not loaded – check internet or run fetch_vendor.py", true); return; }
    if (!stage)  { toast("No plan loaded", true); return; }

    var incBg     = $("pdfOptBg").checked;
    var incSym    = $("pdfOptSym").checked;
    var incLines  = $("pdfOptLines").checked;
    var incSymRef = $("pdfOptSymRef") && $("pdfOptSymRef").checked;

    // Visible layer IDs for the symbol reference table
    var visibleLayerIds = {};
    (state.layers || []).forEach(function (l) {
      if (l.visible !== false) visibleLayerIds[l.id] = l;
    });

    // Hide bg
    var bgVis = bgLayer.visible();
    if (!incBg) bgLayer.visible(false);

    // Hide/show symbols and lines; ALWAYS hide length labels
    shapeLayer.getChildren().forEach(function (node) {
      if (node._isSym  && !incSym)   node.visible(false);
      if (node._isLine && !incLines) node.visible(false);
      if (node._isLineLabel)         node.visible(false);
    });

    var calVis = calLayer.visible();
    calLayer.visible(false);

    stage.toDataURL({ pixelRatio: 2, callback: function (dataUrl) {
      // Restore
      bgLayer.visible(bgVis);
      calLayer.visible(calVis);
      shapeLayer.getChildren().forEach(function (node) {
        if (node._isSym  && !incSym)   node.visible(true);
        if (node._isLine && !incLines) node.visible(true);
        if (node._isLineLabel)         node.visible(true);
      });

      var orient = stage.width() > stage.height() ? "l" : "p";
      var pdf = new JsPDF({ orientation: orient, unit: "mm", format: "a4" });
      var pw = orient === "l" ? 297 : 210;
      var ph = orient === "l" ? 210 : 297;
      var margin = 10;
      var aw = pw - margin * 2;
      var ah = (stage.height() / stage.width()) * aw;
      if (ah > ph - margin * 2 - 20) { ah = ph - margin * 2 - 20; }

      pdf.addImage(dataUrl, "PNG", margin, margin, aw, ah);

// ── Symbol reference table (top-left overlay, same page) ──────────
      if (incSymRef) {
        var byType = {};
        var allSyms = [];
        (state.sheets || []).forEach(function (sh) {
          sh.symbols.forEach(function (s) {
            var typeCfg = (state.symbolTypes && state.symbolTypes[s.type]) || {};
            var lid = s.visibleLayerId || typeCfg.palLayerId || null;
            if (!lid || visibleLayerIds[lid]) allSyms.push(s);
          });
        });
        allSyms.forEach(function (s) {
          if (!byType[s.type]) {
            var info = symInfo(s.type);
            var typeCfg = (state.symbolTypes && state.symbolTypes[s.type]) || {};
            // Rasterise the loaded Image to a small canvas so jsPDF gets a real PNG
            var pngUrl = null;
            var img = symbolImages[s.type];
            if (img && img.complete && img.naturalWidth > 0) {
              try {
                var ic = document.createElement("canvas"); ic.width = 44; ic.height = 44;
                ic.getContext("2d").drawImage(img, 0, 0, 44, 44);
                pngUrl = ic.toDataURL("image/png");
              } catch (ex) {}
            }
            byType[s.type] = { name: info.name || s.type.replace(/_/g, " "), count: 0, currentA: typeCfg.defaultCurrentA, pngUrl: pngUrl };
          }
          byType[s.type].count++;
        });
        var entries = Object.keys(byType).map(function (k) { return byType[k]; });
        entries.sort(function (a, b) { return a.name.localeCompare(b.name); });

        if (entries.length) {
          var tIconW = 6, tW = 75, tRowH = 5.5, tHdrH = 5.5, tTitleH = 6.5, tPad = 1.8;
          var tX = margin, tY = margin;
          var maxRows = Math.floor((ph - margin * 2 - tTitleH - tHdrH) / tRowH);
          var visEntries = entries.slice(0, maxRows);
          var tH = tTitleH + tHdrH + visEntries.length * tRowH + 2;

          // White background box
          pdf.setFillColor(255, 255, 255);
          pdf.setDrawColor(160, 160, 160);
          pdf.rect(tX, tY, tW, tH, "FD");

          // Title bar
          pdf.setFillColor(42, 51, 64);
          pdf.rect(tX, tY, tW, tTitleH, "F");
          pdf.setFontSize(6.5);
          pdf.setFont(undefined, "bold");
          pdf.setTextColor(255, 255, 255);
          pdf.text("Symbol Reference", tX + tPad, tY + 4.5);
          var ty = tY + tTitleH;

          // Column header
          pdf.setFillColor(80, 95, 115);
          pdf.rect(tX, ty, tW, tHdrH, "F");
          pdf.setFontSize(6);
          pdf.setTextColor(220, 220, 220);
          pdf.setFont(undefined, "bold");
          pdf.text("Symbol", tX + tPad,                    ty + 3.8);
          pdf.text("Name",   tX + tPad + tIconW + 2,       ty + 3.8);
          pdf.text("Qty",    tX + tW - 10,                 ty + 3.8);
          pdf.setFont(undefined, "normal");
          ty += tHdrH;

          // Rows
          visEntries.forEach(function (e, i) {
            pdf.setFillColor(i % 2 === 0 ? 255 : 246, i % 2 === 0 ? 255 : 247, i % 2 === 0 ? 255 : 250);
            pdf.rect(tX, ty, tW, tRowH, "F");
            // Symbol icon
            if (e.pngUrl) {
              try { pdf.addImage(e.pngUrl, "PNG", tX + tPad, ty + 0.4, tIconW, tIconW); } catch (ex) {}
            }
            pdf.setTextColor(30, 30, 30);
            pdf.setFontSize(5.8);
            var nameStr = e.name.length > 30 ? e.name.slice(0, 29) + "…" : e.name;
            pdf.text(nameStr,          tX + tPad + tIconW + 2, ty + tRowH - 1.2);
            pdf.text(String(e.count),  tX + tW - 8,            ty + tRowH - 1.2);
            pdf.setDrawColor(215, 215, 215);
            pdf.line(tX, ty + tRowH, tX + tW, ty + tRowH);
            ty += tRowH;
          });

          if (entries.length > maxRows) {
            pdf.setFontSize(5.5);
            pdf.setTextColor(100, 100, 100);
            pdf.text("+" + (entries.length - maxRows) + " more…", tX + tPad, ty + 3);
          }

          // Outer border
          pdf.setDrawColor(140, 140, 140);
          pdf.rect(tX, tY, tW, tH, "S");
        }
      }

      pdf.save((state.name || "plan") + ".pdf");
      closeModal("modalExportPDF");
      toast("PDF saved");
    }});
  }

  function hexToRgb(hex) {
    hex = hex.replace("#", "");
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }

  // Tag Konva nodes so we can selectively hide them for PDF
  var _origRenderActiveSheet = renderActiveSheet;
  renderActiveSheet = function () {
    _origRenderActiveSheet();
    if (sheet()) {
      sheet().symbols.forEach(function (s) {
        if (symbolNodes[s.id]) symbolNodes[s.id]._isSym = true;
        if (refLabelNodes[s.id]) refLabelNodes[s.id]._isSym = true; // ref labels follow symbol visibility
      });
      sheet().lines.forEach(function (l) {
        if (lineNodes[l.id]) {
          lineNodes[l.id].line._isLine      = true;
          lineNodes[l.id].label._isLine     = true;
          lineNodes[l.id].label._isLineLabel = true; // label-specific tag
        }
      });
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 2 – MANUAL TAKEOFF ITEMS
  // ─────────────────────────────────────────────────────────────────────
  function openManualItemModal(existing) {
    var ed = existing || {};
    $("miEditId").value  = ed.id || "";
    $("miDesc").value    = ed.description || "";
    $("miQty").value     = ed.qty || "";
    $("miUnit").value    = ed.unit || "ea";
    $("miCost").value    = ed.cost || "";
    $("miRetail").value  = ed.retail || "";
    $("miLabour").value  = ed.labour || "";
    $("modalManualItem").querySelector("h2").textContent = ed.id ? "Edit manual item" : "Add manual item";
    openModal("modalManualItem");
    setTimeout(function () { $("miDesc").focus(); }, 50);
  }
  function saveManualItem() {
    var desc = $("miDesc").value.trim();
    if (!desc) { toast("Description required", true); return; }
    if (!state.manualTakeoff) state.manualTakeoff = [];
    var id = $("miEditId").value || uid("mi");
    state.manualTakeoff = state.manualTakeoff.filter(function (m) { return m.id !== id; });
    state.manualTakeoff.push({
      id: id,
      description: desc,
      qty:    parseFloat($("miQty").value)    || 0,
      unit:   $("miUnit").value.trim()        || "ea",
      cost:   parseFloat($("miCost").value)   || 0,
      retail: parseFloat($("miRetail").value) || 0,
      labour: parseFloat($("miLabour").value) || 0
    });
    closeModal("modalManualItem");
    refreshTakeoff();
    toast("Item saved");
  }

  // Patch refreshTakeoff to append manual rows
  var _origRefreshTakeoff = refreshTakeoff;
  refreshTakeoff = function () {
    _origRefreshTakeoff();
    renderManualRows();
  };
  function renderManualRows() {
    if (!state || !state.manualTakeoff || !state.manualTakeoff.length) return;
    var rate    = state.labourRate || 0;
    var tbody   = $("tab-takeoff") && $("tab-takeoff").querySelector("tbody");
    var tfoot   = $("tab-takeoff") && $("tab-takeoff").querySelector("tfoot");
    if (!tbody) return;

    var extraCost = 0, extraRetail = 0, extraHrs = 0;
    var rows = '<tr class="group-head"><td colspan="6">Manual items</td></tr>';
    state.manualTakeoff.forEach(function (m) {
      var mc = m.qty * m.cost, mr = m.qty * m.retail, lc = m.labour * rate;
      extraCost   += mc; extraRetail += mr; extraHrs += m.labour;
      rows += '<tr><td><span>' + escapeHtml(m.description) + '</span>' +
        ' <a href="#" style="font-size:10px;color:var(--accent)" data-edit-mi="' + m.id + '">edit</a>' +
        ' <a href="#" style="font-size:10px;color:var(--red,#f87171)" data-del-mi="' + m.id + '">✕</a>' +
        '</td><td class="num">' + m.qty + ' ' + escapeHtml(m.unit) +
        '</td><td class="num">' + fmt$(mc) +
        '</td><td class="num">' + fmt$(mr) +
        '</td><td class="num">' + m.labour.toFixed(2) +
        '</td><td class="num">' + fmt$(lc) + '</td></tr>';
    });
    tbody.insertAdjacentHTML("beforeend", rows);

    // Update subtotal row in tfoot
    if (tfoot) {
      var cells = tfoot.querySelectorAll("td");
      // cells: [SUBTOTAL, empty, cost, retail, hrs, labour]
      if (cells.length >= 6) {
        var origCost   = parseFloat(cells[2].textContent.replace(/[^0-9.]/g, "")) || 0;
        var origRetail = parseFloat(cells[3].textContent.replace(/[^0-9.]/g, "")) || 0;
        var origHrs    = parseFloat(cells[4].textContent) || 0;
        var origLab    = parseFloat(cells[5].textContent.replace(/[^0-9.]/g, "")) || 0;
        cells[2].textContent = fmt$(origCost   + extraCost);
        cells[3].textContent = fmt$(origRetail + extraRetail);
        cells[4].textContent = (origHrs + extraHrs).toFixed(2);
        cells[5].textContent = fmt$(origLab    + extraHrs * rate);
      }
    }

    // Wire edit / delete links
    $("tab-takeoff").querySelectorAll("[data-edit-mi]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var m = (state.manualTakeoff || []).find(function (x) { return x.id === a.dataset.editMi; });
        if (m) openManualItemModal(m);
      };
    });
    $("tab-takeoff").querySelectorAll("[data-del-mi]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        state.manualTakeoff = (state.manualTakeoff || []).filter(function (x) { return x.id !== a.dataset.delMi; });
        refreshTakeoff();
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 3 – LAYER NAME EDITING (already works via inline input;
  //   this adds a double-click hint and colour-picker in the swatch)
  // ─────────────────────────────────────────────────────────────────────
  // The existing renderLayers() already renders <input class="layer-name">
  // so users can click it and type a new name.  Nothing extra needed here.

  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 4 – ASSIGN SYMBOLS TO LAYERS (palette grouping + tag)
  // ─────────────────────────────────────────────────────────────────────
  function populateLayerFilter() {
    var sel = $("symLayerFilter");
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="">All symbols</option>';
    (state.layers || []).forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.id; opt.textContent = l.name;
      sel.appendChild(opt);
    });
    sel.value = current;
  }
  function populateSymLayerPicker() {
    var sel = $("symLayerPicker");
    if (!sel) return;
    sel.innerHTML = '<option value="">— no layer —</option>';
    (state.layers || []).forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.id; opt.textContent = l.name;
      sel.appendChild(opt);
    });
  }
  function addLayerTagsToPalette() {
    var filterLayerId = $("symLayerFilter") ? $("symLayerFilter").value : "";
    $("symbolPalette").querySelectorAll(".sym").forEach(function (el) {
      var type = el.dataset.type;
      var cfg  = state.symbolTypes[type] || {};
      var layId = cfg.palLayerId;
      // Remove any existing tag
      var old = el.querySelector(".sym-layer-tag");
      if (old) old.remove();
      if (layId) {
        var lay = layerById(layId);
        if (lay) {
          var tag = document.createElement("span");
          tag.className = "sym-layer-tag";
          tag.title = "Assigned to layer: " + lay.name;
          tag.style.cssText = "display:block;width:100%;height:3px;border-radius:0 0 4px 4px;background:" + lay.color + ";margin-top:2px";
          el.appendChild(tag);
        }
      }
      // Apply filter
      if (filterLayerId) {
        el.style.display = (layId === filterLayerId) ? "" : "none";
      } else {
        el.style.display = "";
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 5 – CUSTOM SYMBOLS (already in app) + DXF/DWG IMPORT
  // ─────────────────────────────────────────────────────────────────────
  // The existing + button already opens the custom symbol modal.
  // We add a second button "Import DXF/DWG" that sends the file to the server.
  function importDxfSymbol(file) {
    if (!file) return;
    var isDxf = /\.(dxf|dwg)$/i.test(file.name);
    if (!isDxf) { toast("Please select a .dxf or .dwg file", true); return; }
    toast("Importing DXF symbols…");
    var fd = new FormData();
    fd.append("file", file);
    fetch("/api/import-dxf", { method: "POST", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // Show a server-side error but still continue if symbols were returned
        if (j.error && !(j.symbols && j.symbols.length)) {
          toast("DXF import: " + j.error, true);
          return;
        }
        var added = 0;
        state.customSymbols = state.customSymbols || [];
        (j.symbols || []).forEach(function (sym) {
          // Build the display name: primary name + description suffix if present
          var displayName = sym.name || "Symbol";
          if (sym.description) displayName += " — " + sym.description;
          // Avoid exact duplicates (same name already imported)
          var alreadyExists = state.customSymbols.some(function (s) {
            return s.name === displayName;
          });
          if (alreadyExists) return;
          var entry = {
            id:          uid("csym"),
            name:        displayName,
            description: sym.description || "",
            category:    "custom",
            dataURL:     sym.dataURL,
            custom:      true,
            fromDxf:     true,
          };
          state.customSymbols.push(entry);
          delete symbolImages[entry.id];   // force image reload
          ensureSymbolImage(entry.id);
          added++;
        });
        renderPalette();
        if (added > 0) {
          toast(added + " symbol" + (added !== 1 ? "s" : "") + " imported from DXF");
        } else {
          toast("No new symbols — all already imported", true);
        }
        if (j.error) {
          // Partial success warning (e.g. some symbols had no geometry)
          setTimeout(function () { toast("Note: " + j.error, true); }, 2800);
        }
      })
      .catch(function (e) { toast("DXF import failed: " + e.message, true); });
  }
  // Expose so the loader in index.html (outside this IIFE) can call it
  window.importDxfSymbol = importDxfSymbol;

  // ─────────────────────────────────────────────────────────────────────
  // FEATURE 6 – PACKAGED PARTS
  // ─────────────────────────────────────────────────────────────────────
  var pkgComponents = [];
  var pkgEditId     = null;

  function openPackageModal(existing) {
    pkgComponents = existing ? JSON.parse(JSON.stringify(existing.components || [])) : [];
    pkgEditId = existing ? existing.part_no : null;
    $("pkgName").value    = existing ? existing.description : "";
    $("pkgPartNo").value  = existing ? existing.part_no     : "";
    $("pkgMsg").textContent = "";
    $("pkgSearch").value  = "";
    $("pkgSearchResults").innerHTML = "";
    renderPkgComponents();
    openModal("modalPackage");
    setTimeout(function () { $("pkgName").focus(); }, 50);
  }

  // Search parts DB for the package component picker
  function pkgSearchParts(q) {
    var box = $("pkgSearchResults");
    if (!q.trim()) { box.innerHTML = ""; return; }
    box.innerHTML = '<p style="color:var(--faint);font-size:12px;padding:4px">Searching…</p>';
    searchParts(q).then(function (res) {
      box.innerHTML = "";
      if (!res.parts.length) { box.innerHTML = '<p style="color:var(--faint);font-size:12px;padding:4px">No parts found</p>'; return; }
      res.parts.slice(0, 12).forEach(function (p) {
        var d = document.createElement("div");
        d.style.cssText = "padding:5px 8px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px";
        d.innerHTML = '<strong>' + escapeHtml(p.part_no) + '</strong> — ' + escapeHtml(p.description) +
          ' <span style="color:var(--faint)">cost ' + fmt$(p.cost) + ' · retail ' + fmt$(p.retail) + '</span>';
        d.onmouseenter = function () { d.style.background = "var(--panel-3)"; };
        d.onmouseleave = function () { d.style.background = ""; };
        d.onclick = function () {
          pkgComponents.push({ part_no: p.part_no, description: p.description, qty: 1, cost: p.cost || 0, retail: p.retail || 0 });
          renderPkgComponents();
          $("pkgSearch").value = "";
          box.innerHTML = "";
        };
        box.appendChild(d);
      });
    });
  }

  function renderPkgComponents() {
    var box = $("pkgComponentList");
    box.innerHTML = "";
    if (!pkgComponents.length) {
      box.innerHTML = '<p style="color:var(--faint);font-size:12px;padding:4px 0">No components yet. Search above or click ＋ to add manually.</p>';
      updatePkgTotals(); return;
    }
    pkgComponents.forEach(function (comp, i) {
      var row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:1fr 2fr 60px 80px 80px 28px;gap:4px;margin-bottom:4px;align-items:center";
      row.innerHTML =
        '<input style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" ' +
          'placeholder="Part No." value="' + escapeHtml(comp.part_no || "") + '" data-ci="' + i + '" data-field="part_no">' +
        '<input style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" ' +
          'placeholder="Description" value="' + escapeHtml(comp.description || "") + '" data-ci="' + i + '" data-field="description">' +
        '<input type="number" style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" ' +
          'placeholder="Qty" value="' + (comp.qty || 1) + '" data-ci="' + i + '" data-field="qty">' +
        '<input type="number" style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" ' +
          'placeholder="Cost" value="' + (comp.cost || "") + '" data-ci="' + i + '" data-field="cost">' +
        '<input type="number" style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" ' +
          'placeholder="Retail" value="' + (comp.retail || "") + '" data-ci="' + i + '" data-field="retail">' +
        '<button style="padding:3px 6px;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--red,#f87171);cursor:pointer;font-size:12px" data-rm="' + i + '">✕</button>';
      box.appendChild(row);
    });
    box.querySelectorAll("input[data-ci]").forEach(function (inp) {
      inp.oninput = function () {
        var i = parseInt(inp.dataset.ci), f = inp.dataset.field;
        pkgComponents[i] = pkgComponents[i] || {};
        pkgComponents[i][f] = (f === "qty" || f === "cost" || f === "retail") ? (parseFloat(inp.value) || 0) : inp.value;
        updatePkgTotals();
      };
    });
    box.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.onclick = function () { pkgComponents.splice(parseInt(btn.dataset.rm), 1); renderPkgComponents(); };
    });
    updatePkgTotals();
  }
  function addPackageComponentRow() {
    pkgComponents.push({ part_no: "", description: "", qty: 1, cost: 0, retail: 0 });
    renderPkgComponents();
    // focus the first empty input in the new row
    var inputs = $("pkgComponentList").querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 5].focus();
  }
  function updatePkgTotals() {
    var tc = 0, tr = 0;
    pkgComponents.forEach(function (c) { tc += (c.qty || 1) * (c.cost || 0); tr += (c.qty || 1) * (c.retail || 0); });
    $("pkgTotalCost").textContent   = fmt$(tc);
    $("pkgTotalRetail").textContent = fmt$(tr);
  }
  function savePackage() {
    var name = $("pkgName").value.trim();
    var pno  = $("pkgPartNo").value.trim() || ("PKG-" + Math.random().toString(36).slice(2,7).toUpperCase());
    if (!name) { $("pkgMsg").textContent = "Enter a package name"; return; }
    if (!pkgComponents.length) { $("pkgMsg").textContent = "Add at least one component"; return; }
    var tc = 0, tr = 0;
    pkgComponents.forEach(function (c) { tc += (c.qty || 1) * (c.cost || 0); tr += (c.qty || 1) * (c.retail || 0); });
    var pkg = { part_no: pno, description: name, unit: "ea", cost: tc, retail: tr,
                labour: 0, category: "packages", _custom: true, isPackage: true,
                components: JSON.parse(JSON.stringify(pkgComponents)) };
    state.customParts = (state.customParts || []).filter(function (p) { return p.part_no !== pno; });
    state.customParts.push(pkg);
    // Persist to shared packages table in the DB
    fetch("/api/packages", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pkg) }).catch(function () {});
    closeModal("modalPackage");
    renderPartsLibrary($("partsSearch").value);
    toast('Package "' + name + '" saved');
  }

  // Extend takeoffRows so that when a device row links to a package part,
  // we insert extra component sub-rows for the quote / CSV export.
  var _origTakeoffRows = takeoffRows;
  takeoffRows = function () {
    var data = _origTakeoffRows();
    var rate = data.rate;
    var expanded = [];
    data.rows.forEach(function (row) {
      expanded.push(row);
      if (row.kind === "dev" && row.part && row.part.isPackage) {
        (row.part.components || []).forEach(function (comp) {
          var qty = row.effQty * (comp.qty || 1);
          expanded.push({
            kind: "pkg-comp",
            id: row.id + "_" + comp.part_no,
            name: "  └ " + comp.description + " [" + comp.part_no + "]",
            part: comp, color: null, unit: comp.unit || "ea",
            autoQty: qty, effQty: qty, qtyOv: false,
            autoHrs: 0, effHrs: 0, hrsOv: false,
            matCost: qty * (comp.cost || 0), matRetail: qty * (comp.retail || 0),
            labour: 0, meta: ""
          });
        });
      }
    });
    return { rows: expanded, rate: rate };
  };

  // Extend refreshTakeoff section() to render pkg-comp rows
  var _origRefreshTakeoff2 = refreshTakeoff;
  refreshTakeoff = function () {
    // Temporarily re-define section to also handle pkg-comp
    _origRefreshTakeoff2.apply(this, arguments);
    // pkg-comp rows are already injected via takeoffRows; they render inside "Devices" section
    // because section() filters by kind === "dev" — so we manually inject them after each dev row.
    // Actually the current section() only shows kind==="dev", so pkg-comp rows are silently dropped.
    // Fix: add a visual indicator on the device row itself showing it's a package.
    var tbody = $("tab-takeoff") && $("tab-takeoff").querySelector("tbody");
    if (!tbody) return;
    var data = _origTakeoffRows();
    data.rows.forEach(function (row) {
      if (row.kind === "dev" && row.part && row.part.isPackage) {
        // Find the row in DOM and append component summary
        var td = tbody.querySelector("[data-sym='" + CSS.escape(row.id) + "']");
        if (td) {
          var tr = td.closest("tr");
          if (tr) {
            var badge = document.createElement("span");
            badge.style.cssText = "display:inline-block;margin-left:4px;padding:1px 5px;background:var(--accent);color:#000;font-size:10px;border-radius:3px";
            badge.textContent = "PKG";
            td.appendChild(badge);
          }
        }
      }
    });
  };

  // ── Route BOM rows into takeoffRows() so generateQuote() picks them up ──
  var _prevTakeoffRowsRoutes = takeoffRows;
  takeoffRows = function () {
    var data = _prevTakeoffRowsRoutes();
    if (!state) return data;
    function findPart(id) { return id ? (state.customParts || []).find(function (p) { return p.part_no === id; }) : null; }
    var routeRows = [];
    (state.sheets || []).forEach(function (sh) {
      (sh.routes || []).forEach(function (route) {
        if (!route.straightPkgId && !route.cornerPkgId && !route.teePkgId) return;
        var lengthM = route.lengthM || 0;
        var stickCount = lengthM > 0 ? Math.ceil(lengthM / (route.stickLengthM || 4)) : 0;
        var autoC = window.routeAutoCorners ? window.routeAutoCorners(route) : Math.max(0, Math.floor(route.points.length / 2) - 2);
        var cornerCount = (route.cornerCountOverride != null) ? route.cornerCountOverride : autoC;
        var teeCount = route.teeCount || 0;
        var label = route.description || "Route";
        function expandInto(part, qty, slot) {
          if (!part || qty <= 0) return;
          var items = part.isPackage && part.components && part.components.length
            ? part.components.map(function (c) { return { part: c, qty: qty * (c.qty || 1) }; })
            : [{ part: part, qty: qty }];
          items.forEach(function (item) {
            routeRows.push({ kind: "route-bom", id: route.id + "_" + slot + "_" + item.part.part_no,
              name: label + " [" + slot + "]", part: item.part, unit: item.part.unit || "ea",
              autoQty: item.qty, effQty: item.qty, qtyOv: false,
              autoHrs: 0, effHrs: 0, hrsOv: false,
              matCost: item.qty * (item.part.cost || 0), matRetail: item.qty * (item.part.retail || 0),
              labour: 0, meta: "" });
          });
        }
        expandInto(findPart(route.straightPkgId), stickCount,  "straight");
        expandInto(findPart(route.cornerPkgId),   cornerCount, "corner");
        expandInto(findPart(route.teePkgId),       teeCount,   "tee");
      });
    });
    return { rows: data.rows.concat(routeRows), rate: data.rate };
  };

  // ── Route takeoff section ─────────────────────────────────────────
  var _origRefreshTakeoffRoutes = refreshTakeoff;
  refreshTakeoff = function () {
    _origRefreshTakeoffRoutes.apply(this, arguments);
    renderRouteTakeoffRows();
  };
  function renderRouteTakeoffRows() {
    if (!state) return;
    var tbody = $("tab-takeoff") && $("tab-takeoff").querySelector("tbody");
    if (!tbody) return;

    // Collect all routes across all sheets
    var allRoutes = [];
    (state.sheets || []).forEach(function (sh) {
      (sh.routes || []).forEach(function (r) { allRoutes.push(r); });
    });
    // Only show routes that have at least one package linked or a measured length
    var routesWithData = allRoutes.filter(function (r) {
      return r.straightPkgId || r.cornerPkgId || r.teePkgId;
    });
    if (!routesWithData.length) return;

    // Find any custom part or package by part_no
    function findPart(id) {
      if (!id) return null;
      return (state.customParts || []).find(function (p) { return p.part_no === id; });
    }

    var html = '<tr class="group-head"><td colspan="6">Routes &amp; Conduit</td></tr>';

    routesWithData.forEach(function (route) {
      var lengthM     = route.lengthM || 0;
      var stickLen    = route.stickLengthM || 4;
      var stickCount  = lengthM > 0 ? Math.ceil(lengthM / stickLen) : 0;
      var autoCorners = routeAutoCorners(route);
      var cornerCount = (route.cornerCountOverride != null) ? route.cornerCountOverride : autoCorners;
      var teeCount    = route.teeCount || 0;

      var straightPart = findPart(route.straightPkgId);
      var cornerPart   = findPart(route.cornerPkgId);
      var teePart      = findPart(route.teePkgId);

      var label = escapeHtml(route.description || "Route");
      var meta  = lengthM > 0 ? lengthM.toFixed(2) + " m · " + stickCount + " sticks" : "no scale set";
      if (cornerCount) meta += " · " + cornerCount + " corners";
      if (teeCount)    meta += " · " + teeCount + " tees";

      html += '<tr><td colspan="6" style="font-size:11px;font-weight:600;color:var(--text);padding:5px 8px 2px;background:var(--bg-alt)">' +
        label + ' <span style="font-weight:400;color:var(--faint);font-size:10px">' + meta + '</span></td></tr>';

      // Expand a part or package into BOM rows.
      // Package: expand each component × qty. Single part: one row at qty.
      function expandPart(part, qty, slotLabel) {
        if (!part || qty <= 0) return;
        var rows = part.isPackage && part.components && part.components.length
          ? part.components.map(function (c) { return { desc: c.description, pno: c.part_no, unit: c.unit || "ea", cost: c.cost || 0, retail: c.retail || 0, qty: qty * (c.qty || 1) }; })
          : [{ desc: part.description, pno: part.part_no, unit: part.unit || "ea", cost: part.cost || 0, retail: part.retail || 0, qty: qty }];
        rows.forEach(function (r) {
          var mc = r.qty * r.cost, mr = r.qty * r.retail;
          html += '<tr><td style="padding-left:18px;font-size:11px">└ <span style="color:var(--faint);font-size:10px">[' + escapeHtml(slotLabel) + ']</span> ' +
            escapeHtml(r.desc) + ' <span style="color:var(--faint);font-size:10px">[' + escapeHtml(r.pno) + ']</span>' +
            '</td><td class="num">' + r.qty + ' ' + escapeHtml(r.unit) +
            '</td><td class="num">' + fmt$(mc) +
            '</td><td class="num">' + fmt$(mr) +
            '</td><td class="num">—</td><td class="num">—</td></tr>';
        });
      }

      expandPart(straightPart, stickCount,  "straight ×" + stickCount);
      expandPart(cornerPart,   cornerCount, "corner ×"   + cornerCount);
      expandPart(teePart,      teeCount,    "tee ×"      + teeCount);
    });

    tbody.insertAdjacentHTML("beforeend", html);
    // Totals are already included via takeoffRows() patch — no manual tfoot update needed.
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

// ─────────────────────────────────────────────────────────────────────
// SYMBOL PROPERTIES + CIRCUITS — appended to the IIFE via separate scope
// ─────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // ── Tab switcher (shared) ──────────────────────────────────────────
  window.switchTab = function (tab) {
    // circuits is now the bottom drawer, not a sidebar tab
    if (tab === "circuits") {
      if (window.circuitsDrawerSetOpen) window.circuitsDrawerSetOpen(true);
      return;
    }
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === tab); });
    var bodies = { takeoff: "tab-takeoff", parts: "tab-parts", properties: "tab-properties" };
    Object.keys(bodies).forEach(function (k) {
      var el = $(bodies[k]); if (el) el.style.display = k === tab ? "block" : "none";
    });
    if (tab === "parts" && window.renderPartsLibrary) renderPartsLibrary($("partsSearch").value);
  };

  // ── Helpers shared across this module ─────────────────────────────
  function getState()  { return window._appState  || null; }
  function getSheets() { var s = getState(); return s ? s.sheets : []; }
  function getLayers() { var s = getState(); return s ? s.layers : []; }
  function getCircuits() { var s = getState(); if (!s) return []; if (!s.circuits) s.circuits = []; return s.circuits; }
  function circuitById(id) { return getCircuits().find(function (c) { return c.id === id; }); }
  function allPlacedSymbols() {
    var syms = [];
    getSheets().forEach(function (sh) { sh.symbols.forEach(function (s) { syms.push({ sym: s, sheet: sh }); }); });
    return syms;
  }
  function symLabel(s) {
    if (s.refNo) return s.refNo;
    if (s.partNo) return s.partNo;
    return s.type.replace(/_/g, " ");
  }

  // ── Properties panel ──────────────────────────────────────────────
  window.renderPropertiesPanel = function (sym) {
    var box = $("tab-properties"); if (!box) return;
    if (!sym) {
      box.innerHTML = '<p style="color:var(--faint);padding:12px 8px;font-size:12px">Select a symbol on the plan to view and edit its properties.</p>';
      return;
    }
    var circuits = getCircuits();
    var layers   = getLayers();
    var typeCfg  = (getState().symbolTypes && getState().symbolTypes[sym.type]) || {};

    var circOpts = '<option value="">— none —</option>';
    circuits.forEach(function (c) {
      circOpts += '<option value="' + c.id + '"' + (sym.circuitId === c.id ? " selected" : "") + '>' + escHtml(c.name) + '</option>';
    });

    var layOpts = '<option value="">— not assigned —</option>';
    layers.forEach(function (l) {
      layOpts += '<option value="' + l.id + '"' + (sym.visibleLayerId === l.id ? " selected" : "") + '>' + escHtml(l.name) + '</option>';
    });

    // Part number — per-instance override takes priority over type-level part.
    // sym.partOverride === null means explicitly "no part for this instance".
    // sym.partOverride === undefined means "use the type-level part".
    var hasInstanceOverride = sym.hasOwnProperty("partOverride");
    var typePart   = typeCfg.part || null;
    var activePart = hasInstanceOverride ? sym.partOverride : typePart;
    var partBadge;
    if (activePart) {
      var overrideNote = hasInstanceOverride
        ? '<span style="color:var(--accent);font-size:10px;margin-left:4px">[instance override]</span>'
        : '<span style="color:var(--faint);font-size:10px;margin-left:4px">[type default]</span>';
      partBadge = '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--accent);border-radius:5px;font-size:12px;margin-bottom:5px">' +
        '<span style="flex:1"><strong>' + escHtml(activePart.part_no) + '</strong>' + (activePart.description ? ' — ' + escHtml(activePart.description) : '') + overrideNote + '</span>' +
        '</div>';
    } else if (hasInstanceOverride) {
      partBadge = '<div style="color:var(--faint);font-size:12px;padding:3px 0 5px">No part for this instance <span style="color:var(--accent)">[override]</span></div>';
    } else {
      partBadge = '<div style="color:var(--faint);font-size:12px;padding:3px 0 5px">No part linked' + (typePart ? '' : ' to this symbol type') + '</div>';
    }

    // Drop length — show target layer from type config, or use visibleLayerId as fallback
    var dropLayerId  = typeCfg.dropLayerId || sym.visibleLayerId || null;
    var dropLayer    = dropLayerId ? layers.find(function (l) { return l.id === dropLayerId; }) : null;
    var dropLenVal   = sym.dropLength != null ? sym.dropLength : 1;
    var dropSection;
    if (dropLayer) {
      dropSection =
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Cable drop</div>' +
        '<div style="margin-bottom:4px">' +
          '<label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">' +
            'Drop length (m) → <span style="color:' + escHtml(dropLayer.color) + '">' + escHtml(dropLayer.name) + '</span></label>' +
          '<input id="prop-dropLength" type="number" step="0.1" min="0" value="' + dropLenVal + '" ' +
            'style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark">' +
          '<div style="font-size:10px;color:var(--faint);margin-top:3px">This length is added to the <strong>' + escHtml(dropLayer.name) + '</strong> layer total in the takeoff.</div>' +
        '</div>' +
        '</div>';
    } else {
      dropSection =
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Cable drop</div>' +
        '<div style="font-size:11px;color:var(--faint)">Assign this symbol to a layer (below) or configure a drop layer via <em>Assign Part</em> to enable drop length tracking.</div>' +
        '</div>';
    }

    box.innerHTML =
      '<div style="padding:10px 8px">' +
      '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Symbol — ' + escHtml(sym.type.replace(/_/g," ")) + '</div>' +

      // Unified part number block
      '<div style="margin-bottom:10px">' +
        '<label style="display:block;font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Part number</label>' +
        partBadge +
        '<button id="prop-assign-part" class="btn ghost" style="width:100%;justify-content:center;font-size:12px;padding:4px 8px">' +
          (activePart ? '✏️ Change part (this instance)' : '🔗 Link part (this instance)') +
        '</button>' +
        (hasInstanceOverride ? '<button id="prop-clear-part-override" class="btn ghost" style="width:100%;justify-content:center;font-size:11px;padding:3px 8px;margin-top:3px;color:var(--muted)">↺ Revert to type default' + (typePart ? ' (' + escHtml(typePart.part_no) + ')' : ' (none)') + '</button>' : '') +
      '</div>' +

      propRow("Reference no.",    "prop-refNo",     sym.refNo  || "",  "text",   "e.g. GPO-01") +
      propRow("Circuit",          "prop-circuitId", sym.circuitId || "", "select", circOpts) +

      '<div style="margin-bottom:8px">' +
        '<label style="display:block;font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">' +
          'Layer <span style="color:var(--faint)">(hides with layer · feeds drop)</span></label>' +
        '<select id="prop-visLayerId" style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark">' +
          layOpts + '</select>' +
      '</div>' +

      dropSection +

      '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">' +
      '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Load current (A)</div>' +
      (sym.currentContrib != null
        ? '<div style="font-size:10px;margin-bottom:5px"><span style="color:var(--accent)">Instance override</span> <span style="color:var(--faint)">— type default: ' + (typeCfg.defaultCurrentA != null ? typeCfg.defaultCurrentA + ' A' : 'not set') + '</span></div>'
        : typeCfg.defaultCurrentA != null
          ? '<div style="font-size:10px;color:var(--faint);margin-bottom:5px">Using type default (' + typeCfg.defaultCurrentA + ' A) — enter a value below to override this instance only</div>'
          : '<div style="font-size:10px;color:var(--faint);margin-bottom:5px">No type default set. Set one via <em>Assign Part</em>, or enter an instance value below.</div>'
      ) +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<input id="prop-currentContrib" type="number" step="0.1" min="0" value="' +
          (sym.currentContrib != null ? sym.currentContrib : "") +
        '" placeholder="' + (typeCfg.defaultCurrentA != null ? typeCfg.defaultCurrentA + ' A (type default)' : 'e.g. 0.5') + '" style="flex:1;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark;font-size:12px">' +
        '<span style="font-size:12px;color:var(--muted);white-space:nowrap">A</span>' +
      '</div>' +
      (sym.currentContrib != null ? '<button id="prop-clear-current" style="margin-top:4px;background:none;border:none;color:var(--faint);font-size:10px;cursor:pointer;padding:0">↺ Clear override — revert to type default</button>' : '') +
      '</div>' +

      '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">' +
      '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Size &amp; rotation</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      numRow("Size (px)", "prop-size", sym.size || 30) +
      numRow("Rotation °", "prop-rotation", sym.rotation || 0) +
      '</div>' +
      '</div>' +
      '</div>' +

      '<button class="btn" style="width:100%;justify-content:center;margin-top:12px;color:var(--red,#f87171)" id="prop-delete">🗑 Delete symbol</button>' +
      '</div>';

    // ── Assign part button (per-instance) ───────────────────────
    var assignBtn = $("prop-assign-part");
    if (assignBtn) assignBtn.onclick = function () {
      window.openAssign("symbol", sym.type, sym);
    };
    // ── Revert instance override back to type default ────────────
    var revertBtn = $("prop-clear-part-override");
    if (revertBtn) revertBtn.onclick = function () {
      delete sym.partOverride;
      refreshTakeoff();
      renderPropertiesPanel(sym);
      toast("Reverted to type default");
    };

    // ── Other field wiring ───────────────────────────────────────
    function wire(fieldId, prop, transform) {
      var el = $(fieldId); if (!el) return;
      el.oninput = el.onchange = function () {
        sym[prop] = transform ? transform(el.value) : el.value;
        if (prop === "circuitId") renderCircuitsTable();
        if (prop === "visibleLayerId") {
          // Update canvas visibility immediately
          var node = window.symbolNodes && window.symbolNodes[sym.id];
          if (node) {
            if (el.value) {
              var lay = getLayers().find(function (l) { return l.id === el.value; });
              node.visible(lay ? lay.visible !== false : true);
            } else {
              node.visible(true);
            }
            if (window.shapeLayer) window.shapeLayer.batchDraw();
          }
          // Keep unassigned symbols on top
          if (window.liftUnassignedSymbols) window.liftUnassignedSymbols();
          // Re-render panel so drop section updates with new layer info
          renderPropertiesPanel(sym);
        }
      };
    }

    wire("prop-refNo",      "refNo", function (v) {
      if (window.syncRefLabel) window.syncRefLabel(sym);
      return v;
    });
    wire("prop-circuitId",  "circuitId");
    wire("prop-visLayerId", "visibleLayerId");
    wire("prop-dropLength", "dropLength", function (v) {
      var n = parseFloat(v);
      var result = isNaN(n) ? 1 : Math.max(0, n);
      refreshTakeoff();
      return result;
    });
    wire("prop-size",       "size", function (v) {
      var n = parseInt(v) || 30;
      var node = window.symbolNodes && window.symbolNodes[sym.id];
      if (node) { node.width(n); node.height(n); node.offsetX(n/2); node.offsetY(n/2); }
      if (window.syncRefLabel) window.syncRefLabel(sym);
      if (window.shapeLayer) window.shapeLayer.batchDraw();
      return n;
    });
    wire("prop-rotation", "rotation", function (v) {
      var n = parseFloat(v) || 0;
      var node = window.symbolNodes && window.symbolNodes[sym.id];
      if (node) { node.rotation(n); if (window.shapeLayer) window.shapeLayer.batchDraw(); }
      return n;
    });

    wire("prop-currentContrib", "currentContrib", function (v) {
      var n = parseFloat(v);
      // Empty field = clear instance override (fall back to type default)
      var result = (v === "" || isNaN(n)) ? null : Math.max(0, n);
      clearTimeout(wire._ccTimer);
      wire._ccTimer = setTimeout(function () {
        if (window.renderCircuitsTable) window.renderCircuitsTable();
      }, 500);
      return result;
    });

    var clearCurBtn = $("prop-clear-current");
    if (clearCurBtn) clearCurBtn.onclick = function () {
      sym.currentContrib = null;
      renderPropertiesPanel(sym);
      clearTimeout(wire._ccTimer);
      wire._ccTimer = setTimeout(function () {
        if (window.renderCircuitsTable) window.renderCircuitsTable();
      }, 500);
    };

    var del = $("prop-delete");
    if (del) del.onclick = function () {
      if (window.deleteSelected) window.deleteSelected();
      box.innerHTML = '<p style="color:var(--faint);padding:12px 8px;font-size:12px">Symbol deleted.</p>';
    };
  };

  function propRow(label, id, val, type, hintOrOpts) {
    var inp;
    if (type === "select") {
      inp = '<select id="' + id + '" style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark">' + hintOrOpts + '</select>';
    } else {
      inp = '<input id="' + id + '" type="' + type + '" value="' + escHtml(val) + '" placeholder="' + (hintOrOpts || "") + '" style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark">';
    }
    return '<div style="margin-bottom:8px"><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">' + label + '</label>' + inp + '</div>';
  }
  function numRow(label, id, val) {
    return '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">' + label + '</label>' +
      '<input id="' + id + '" type="number" value="' + val + '" style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark"></div>';
  }

  // ── Circuits table ─────────────────────────────────────────────────
  window.renderCircuitsTable = function () {
    var box = $("tab-circuits"); if (!box) return;
    var circuits = getCircuits();
    var st = getState();

    var byCircuit = {};
    allPlacedSymbols().forEach(function (item) {
      var cid = item.sym.circuitId;
      if (!cid) return;
      if (!byCircuit[cid]) byCircuit[cid] = [];
      byCircuit[cid].push(item);
    });

    // Compute total cable length for a circuit:
    // line lengths on layers used by its symbols + drop lengths from those symbols
    function circuitLength(cid) {
      var items = byCircuit[cid] || [];
      if (!items.length) return null;
      var layerIds = {};
      items.forEach(function (item) {
        var s = item.sym;
        var typeCfg = (st.symbolTypes && st.symbolTypes[s.type]) || {};
        var lid = s.visibleLayerId || typeCfg.palLayerId || null;
        if (lid) layerIds[lid] = true;
      });
      var lineTotal = 0;
      (st.sheets || []).forEach(function (sh) {
        sh.lines.forEach(function (l) {
          if (layerIds[l.layerId]) lineTotal += (l.lengthM || 0);
        });
      });
      var dropTotal = 0;
      items.forEach(function (item) {
        var s = item.sym;
        dropTotal += (s.dropLength != null) ? s.dropLength : 1;
      });
      return { line: lineTotal, drop: dropTotal, total: lineTotal + dropTotal };
    }

    var html =
      '<div style="padding:8px">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">' +
        '<span style="flex:1;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px">Circuits</span>' +
        '<button class="btn ghost" id="loadMonBtn" style="padding:3px 10px;font-size:12px" title="Toggle live load monitor for active layer">&#9889; Load</button>' +
        '<button class="btn ghost print-sched-btn" style="padding:3px 10px;font-size:12px" id="printSchedBtn">&#128424; Print</button>' +
        '<button class="btn" id="addCircuitBtn" style="padding:3px 10px;font-size:12px">+ Add</button>' +
      '</div>';

    var CABLE_CORES = ["","2C+E","3C+E","4C+E","SDI","TWIN"];
    var CABLE_TYPES = ["","TPS Flat","TPS Orange Circ","TPS Blue","TPS Pink","XLPE","TPI","Metallic Sheathed","Sector"];

    if (!circuits.length) {
      html += '<p style="color:var(--faint);font-size:12px">No circuits yet. Click + Add to create one, then assign symbols via the Properties tab.</p>';
    } else {
      html +=
        '<div style="display:grid;grid-template-columns:1fr 52px 58px 80px 80px 58px 28px;gap:4px;padding:0 4px;margin-bottom:3px">' +
          '<span style="font-size:10px;color:var(--faint)">Name</span>' +
          '<span style="font-size:10px;color:var(--faint)">CB</span>' +
          '<span style="font-size:10px;color:var(--faint)">Size</span>' +
          '<span style="font-size:10px;color:var(--faint)">Cores</span>' +
          '<span style="font-size:10px;color:var(--faint)">Type</span>' +
          '<span style="font-size:10px;color:var(--faint)">Length</span>' +
          '<span></span>' +
        '</div>';

      circuits.forEach(function (c) {
        var devs = byCircuit[c.id] || [];
        var devList = devs.map(function (d) { return escHtml(symLabel(d.sym)); }).join(", ") || '<span style="color:var(--faint)">none</span>';
        var coresSel = CABLE_CORES.map(function (v) {
          return '<option value="' + v + '"' + ((c.cableCores || "") === v ? " selected" : "") + '>' + (v || "—") + '</option>';
        }).join("");
        var typesSel = CABLE_TYPES.map(function (v) {
          return '<option value="' + v + '"' + ((c.cableType || "") === v ? " selected" : "") + '>' + (v || "—") + '</option>';
        }).join("");

        var len = circuitLength(c.id);
        var lenCell;
        if (!len) {
          lenCell = '<span style="color:var(--faint);font-size:11px">—</span>';
        } else {
          var tip = len.line.toFixed(1) + "m run + " + len.drop.toFixed(1) + "m drops";
          lenCell = '<span style="font-size:12px;font-family:var(--mono);color:var(--accent)" title="' + tip + '">' +
            len.total.toFixed(1) + ' m</span>';
        }

        html +=
          '<div style="border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--panel-2)">' +
          '<div style="display:grid;grid-template-columns:1fr 52px 58px 80px 80px 58px 28px;gap:4px;align-items:center;padding:7px 8px">' +
            '<input data-cid="' + c.id + '" data-field="name" value="' + escHtml(c.name) + '" placeholder="Circuit name"' +
              ' style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px;font-weight:500">' +
            '<input data-cid="' + c.id + '" data-field="cbRating" value="' + escHtml(c.cbRating || "") + '" placeholder="20A"' +
              ' style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" title="CB rating">' +
            '<input data-cid="' + c.id + '" data-field="cableSize" value="' + escHtml(c.cableSize || "") + '" placeholder="2.5mm&sup2;"' +
              ' style="padding:4px 6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" title="Cable size">' +
            '<select data-cid="' + c.id + '" data-field="cableCores"' +
              ' style="padding:4px 4px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" title="Cable cores">' +
              coresSel + '</select>' +
            '<select data-cid="' + c.id + '" data-field="cableType"' +
              ' style="padding:4px 4px;background:var(--bg-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);color-scheme:dark;font-size:12px" title="Cable type">' +
              typesSel + '</select>' +
            '<div style="text-align:right;padding-right:2px">' + lenCell + '</div>' +
            '<button data-delcid="' + c.id + '" style="background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--red,#f87171);cursor:pointer;font-size:12px;padding:3px 5px">&#10005;</button>' +
          '</div>' +
          '<div style="padding:4px 8px 7px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<span style="color:var(--faint)">Devices: </span>' + devList +
            '<label style="margin-left:auto;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;font-size:11px;color:var(--muted)" title="When checked, VD/ELFI/Lmax use the sum of device current contributions (AS/NZS 3000 Table C9) instead of 50% of CB rating">' +
              '<input type="checkbox" data-cid="' + c.id + '" data-field="useDeviceCurrent"' + (c.useDeviceCurrent ? ' checked' : '') + ' style="accent-color:var(--accent)">' +
              'Use device A' +
            '</label>' +
          '</div></div>';
      });
    }
    html += '</div>';
    box.innerHTML = html;

    // Wire inputs and selects
    // For fields that affect VD/ELFI/Lmax, debounce the re-render by 500ms
    // so it only fires after the user stops typing, not on every keystroke.
    var _recalcTimer = null;
    var recalcFields = { cbRating: 1, cableSize: 1, cableCores: 1 };
    box.querySelectorAll("input[data-cid], select[data-cid]").forEach(function (el) {
      el.oninput = el.onchange = function () {
        var c = circuitById(el.dataset.cid);
        if (c) {
          if (el.type === "checkbox") {
            // Checkboxes: store boolean, recalc immediately
            c[el.dataset.field] = el.checked;
            renderCircuitsTable();
          } else {
            c[el.dataset.field] = el.value;
            if (recalcFields[el.dataset.field]) {
              clearTimeout(_recalcTimer);
              _recalcTimer = setTimeout(function () { renderCircuitsTable(); }, 500);
            }
          }
        }
      };
    });
    box.querySelectorAll("[data-delcid]").forEach(function (btn) {
      btn.onclick = function () {
        var cid = btn.dataset.delcid;
        getState().circuits = getState().circuits.filter(function (c) { return c.id !== cid; });
        allPlacedSymbols().forEach(function (d) { if (d.sym.circuitId === cid) d.sym.circuitId = ""; });
        renderCircuitsTable();
      };
    });
    var addBtn = $("addCircuitBtn");
    if (addBtn) addBtn.onclick = function () {
      var n = getCircuits().length + 1;
      getState().circuits.push({ id: uid_c(), name: "Circuit " + n, cbRating: "", cableSize: "", cableCores: "", cableType: "", notes: "" });
      renderCircuitsTable();
      if (window._selectedSym) renderPropertiesPanel(window._selectedSym);
    };
    var printBtn = $("printSchedBtn");
    if (printBtn) printBtn.onclick = function () { window.printCircuitSchedule(); };
    var loadMonBtn = $("loadMonBtn");
    if (loadMonBtn) loadMonBtn.onclick = function () {
      if (window.toggleLoadMonitor) window.toggleLoadMonitor();
    };
  };


  function uid_c() { return "circ_" + Math.random().toString(36).slice(2, 9); }
  function escHtml(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // Keep track of selected sym so circuits table can refresh the dropdown
  var _origSelect = window.select;
  // Patch via the existing select that's inside the IIFE — we hook via DOM event instead
  document.addEventListener("click", function () {
    // After a click, store the last selected sym so circuits table can reference it
    setTimeout(function () {
      if (window._appSelectedSym) window._selectedSym = window._appSelectedSym;
    }, 100);
  });

  // ── Print circuit schedule ─────────────────────────────────────────
  window.printCircuitSchedule = function () {
    var circuits  = getCircuits();
    var st = getState();
    var byCircuit = {};
    allPlacedSymbols().forEach(function (item) {
      var cid = item.sym.circuitId;
      if (!cid) return;
      if (!byCircuit[cid]) byCircuit[cid] = [];
      byCircuit[cid].push(item.sym);
    });
    var projName = (st && st.name) || "Untitled project";

    function circuitLengthPrint(cid) {
      var syms = byCircuit[cid] || [];
      if (!syms.length) return null;
      var layerIds = {};
      syms.forEach(function (s) {
        var typeCfg = (st.symbolTypes && st.symbolTypes[s.type]) || {};
        var lid = s.visibleLayerId || typeCfg.palLayerId || null;
        if (lid) layerIds[lid] = true;
      });
      var lineTotal = 0;
      (st.sheets || []).forEach(function (sh) {
        sh.lines.forEach(function (l) {
          if (layerIds[l.layerId]) lineTotal += (l.lengthM || 0);
        });
      });
      var dropTotal = 0;
      syms.forEach(function (s) { dropTotal += (s.dropLength != null) ? s.dropLength : 1; });
      return (lineTotal + dropTotal).toFixed(1) + " m";
    }

    var rows = circuits.map(function (c, idx) {
      var devs = (byCircuit[c.id] || []).map(function (s) { return symLabel(s); }).join(", ") || "—";
      var len  = circuitLengthPrint(c.id) || "—";
      var bg   = idx % 2 === 0 ? "#ffffff" : "#f4f6f9";
      return '<tr style="background:' + bg + '">' +
        '<td>' + escHtml(c.name) + '</td>' +
        '<td style="text-align:center">' + escHtml(c.cbRating || "—") + '</td>' +
        '<td style="text-align:center">' + escHtml(c.cableSize || "—") + '</td>' +
        '<td style="text-align:center">' + escHtml(c.cableCores || "—") + '</td>' +
        '<td style="text-align:center">' + escHtml(c.cableType || "—") + '</td>' +
        '<td style="text-align:center">' + escHtml(len) + '</td>' +
        '<td>' + escHtml(devs) + '</td>' +
        '</tr>';
    }).join("");

    var html =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<title>Circuit Schedule — ' + escHtml(projName) + '</title>' +
      '<style>' +
        '* { box-sizing: border-box; margin: 0; padding: 0; }' +
        'body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; padding: 20mm 15mm; }' +
        'h1 { font-size: 18px; margin-bottom: 4px; }' +
        '.meta { color: #555; font-size: 11px; margin-bottom: 16px; }' +
        'table { width: 100%; border-collapse: collapse; margin-top: 8px; }' +
        'thead tr { background: #2a3340 !important; }' +
        'th { color: #fff; padding: 9px 11px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }' +
        'th.center, td.center { text-align: center; }' +
        'td { padding: 8px 11px; border-bottom: 1px solid #ddd; vertical-align: top; }' +
        '.btn-print { display: inline-block; margin-bottom: 16px; padding: 8px 20px; background: #ffb02e; border: none; border-radius: 5px; font-size: 13px; font-weight: 600; cursor: pointer; }' +
        '@media print { .no-print { display: none !important; } }' +
      '</style></head><body>' +
      '<div class="no-print" style="margin-bottom:16px">' +
        '<button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button>' +
      '</div>' +
      '<h1>Circuit Schedule</h1>' +
      '<p class="meta">Project: <strong>' + escHtml(projName) + '</strong>&nbsp;&nbsp;|&nbsp;&nbsp;Date: ' + new Date().toLocaleDateString("en-AU") + '</p>' +
      '<table>' +
        '<thead><tr>' +
          '<th>Circuit name</th>' +
          '<th class="center">CB rating</th>' +
          '<th class="center">Cable size</th>' +
          '<th class="center">Cable cores</th>' +
          '<th class="center">Cable type</th>' +
          '<th class="center">Length</th>' +
          '<th>Devices / loads</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<script>setTimeout(function(){ window.print(); }, 500);<\/script>' +
      '</body></html>';

    var w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
    else toast("Allow popups to print", true);
  };

  // ── Sidebar resize ─────────────────────────────────────────────────
  function initSidebarResize() {
    var app = document.getElementById("app");

    function makeDragger(handleId, side) {
      var handle = document.getElementById(handleId);
      if (!handle) return;
      var dragging = false, startX = 0, startW = 0;

      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = parseInt(getComputedStyle(app).getPropertyValue(side === "left" ? "--lw" : "--rw")) || (side === "left" ? 286 : 430);
        handle.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        var delta = side === "left" ? (e.clientX - startX) : (startX - e.clientX);
        var newW  = Math.max(180, Math.min(600, startW + delta));
        app.style.setProperty(side === "left" ? "--lw" : "--rw", newW + "px");
      });

      document.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      });
    }

    makeDragger("resizeLeft",  "left");
    makeDragger("resizeRight", "right");
  }

  // ── Route properties panel ─────────────────────────────────────────
  window.renderRouteProperties = function (route) {
    var box = $("tab-properties"); if (!box) return;
    var state = getState(); if (!state) return;

    function calcStats() {
      var lm  = route.lengthM;
      var sl  = route.stickLengthM || 4;
      var sc  = (lm != null && lm > 0) ? Math.ceil(lm / sl) : null;
      var ac  = window.routeAutoCorners ? window.routeAutoCorners(route) : Math.max(0, Math.floor(route.points.length / 2) - 2);
      var cc  = (route.cornerCountOverride != null) ? route.cornerCountOverride : ac;
      var tc  = route.teeCount || 0;
      return { lm: lm, sc: sc, ac: ac, cc: cc, tc: tc };
    }

    function statsHtml(s) {
      return '<div id="rte-stats" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">' +
        '<div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;padding:6px 8px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase">Length</div><div style="font-size:13px;font-weight:600">' + (s.lm != null ? s.lm.toFixed(2) + ' m' : '<span style="color:var(--faint)">no scale</span>') + '</div></div>' +
        '<div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;padding:6px 8px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase">Sticks</div><div style="font-size:13px;font-weight:600">' + (s.sc != null ? s.sc : '—') + '</div></div>' +
        '<div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;padding:6px 8px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase">Corners <span style="font-size:9px">(auto ' + s.ac + ')</span></div><div style="font-size:13px;font-weight:600">' + s.cc + '</div></div>' +
        '<div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;padding:6px 8px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase">Tees</div><div style="font-size:13px;font-weight:600">' + s.tc + '</div></div>' +
        '</div>';
    }

    function field(label, id, val, type, placeholder, extra) {
      return '<div style="margin-bottom:8px">' +
        '<label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">' + label + '</label>' +
        '<input id="' + id + '" type="' + (type||"text") + '" value="' + escHtml(String(val != null ? val : "")) + '"' +
        (placeholder ? ' placeholder="' + escHtml(placeholder) + '"' : '') + (extra||"") +
        ' style="width:100%;padding:6px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark;font-size:12px;box-sizing:border-box"></div>';
    }

    // Inline search picker — renders a label + selected badge + search input + results list
    function pickerHtml(label, slotId, currentPartNo) {
      var cp = (state.customParts || []).find(function (p) { return p.part_no === currentPartNo; });
      var badgeHtml = cp
        ? '<div id="' + slotId + '-badge" style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg-alt);border:1px solid var(--accent);border-radius:5px;font-size:11px;margin-bottom:4px">' +
            '<span style="flex:1"><strong>' + escHtml(cp.part_no) + '</strong> — ' + escHtml(cp.description) +
              (cp.isPackage ? ' <span style="color:var(--accent);font-size:10px">[pkg]</span>' : '') + '</span>' +
            '<button id="' + slotId + '-clear" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:14px;line-height:1;padding:0">×</button>' +
          '</div>'
        : '<div id="' + slotId + '-badge" style="color:var(--faint);font-size:11px;margin-bottom:4px">None selected</div>';
      return '<div style="margin-bottom:10px">' +
        '<label style="display:block;font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">' + label + '</label>' +
        badgeHtml +
        '<input id="' + slotId + '-q" type="text" placeholder="Search parts &amp; packages…" ' +
          'style="width:100%;padding:5px 8px;background:var(--bg-alt);border:1px solid var(--border);border-radius:5px;color:var(--text);color-scheme:dark;font-size:12px;box-sizing:border-box">' +
        '<div id="' + slotId + '-res" style="max-height:130px;overflow-y:auto;border:1px solid var(--border);border-top:none;border-radius:0 0 5px 5px;display:none"></div>' +
        '</div>';
    }

    var s0 = calcStats();
    box.innerHTML =
      '<div style="padding:10px 8px">' +
      '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Route / Conduit</div>' +
      statsHtml(s0) +
      field("Description", "rte-desc", route.description || "", "text", "e.g. 100mm Cable Tray") +
      field("Width (mm, 0 = thin line)", "rte-lw", route.lineWidthM > 0 ? Math.round(route.lineWidthM * 1000) : 0, "number", "0", ' step="10" min="0" max="2000"') +
      field("Stick / section length (m)", "rte-stick", route.stickLengthM || 4, "number", "4.0", ' step="0.1" min="0.1"') +
      '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Fittings</div>' +
        '<div style="font-size:10px;color:var(--faint);margin-bottom:8px">Corners auto-counted from vertices — override if needed.</div>' +
        field("Corner count override", "rte-corners", route.cornerCountOverride != null ? route.cornerCountOverride : "", "number", "auto (" + s0.ac + ")", ' min="0" step="1"') +
        field("Tee count (manual)", "rte-tees", route.teeCount || 0, "number", "0", ' min="0" step="1"') +
      '</div>' +
      '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Part / package links</div>' +
        pickerHtml("Straight (per stick)",  "rte-str", route.straightPkgId) +
        pickerHtml("Corner (per corner)",   "rte-cor", route.cornerPkgId) +
        pickerHtml("Tee (per tee)",         "rte-tee", route.teePkgId) +
      '</div>' +
      '<button class="btn" style="width:100%;justify-content:center;margin-top:12px;color:var(--red,#f87171)" id="rte-delete">🗑 Delete route</button>' +
      '</div>';

    // Update just the stats block without re-rendering the whole panel
    function refreshStats() {
      var sd = $("rte-stats"); if (!sd) return;
      sd.outerHTML = statsHtml(calcStats());
    }

    // Wire simple fields
    function wireField(id, prop, transform) {
      var el = $(id); if (!el) return;
      el.onchange = function () {
        route[prop] = transform ? transform(el.value) : el.value;
        refreshStats();
        if (window.refreshTakeoff) window.refreshTakeoff();
      };
    }
    wireField("rte-desc", "description");
    wireField("rte-stick", "stickLengthM", function (v) { return parseFloat(v) || 4; });
    var lwEl = $("rte-lw"); if (lwEl) { lwEl.onchange = function () {
      var mm = Math.max(0, parseFloat(lwEl.value) || 0); route.lineWidthM = mm / 1000;
      if (window.updateRouteWidth) window.updateRouteWidth(route.id, route.lineWidthM);
    }; }
    wireField("rte-corners", "cornerCountOverride", function (v) { var t = v.trim(); return t === "" ? null : Math.max(0, parseInt(t) || 0); });
    wireField("rte-tees", "teeCount", function (v) { return Math.max(0, parseInt(v) || 0); });

    // Wire searchable part pickers
    var _srch = window.searchParts, _deb = window.debounce;
    function setupPicker(slotId, routeProp) {
      var qEl  = $(slotId + "-q");
      var resEl = $(slotId + "-res");
      if (!qEl || !resEl || !_srch) return;

      function showResults(q) {
        resEl.innerHTML = '<div style="padding:6px 8px;color:var(--faint);font-size:11px">Searching…</div>';
        resEl.style.display = "block";
        _srch(q).then(function (res) {
          resEl.innerHTML = "";
          if (!res.parts.length) { resEl.innerHTML = '<div style="padding:6px 8px;color:var(--faint);font-size:11px">No results</div>'; return; }
          res.parts.slice(0, 40).forEach(function (p) {
            var d = document.createElement("div");
            d.style.cssText = "padding:5px 8px;cursor:pointer;font-size:11px;border-bottom:1px solid var(--border)";
            d.innerHTML = '<strong>' + escHtml(p.part_no) + '</strong> — ' + escHtml(p.description) +
              (p.isPackage ? ' <span style="color:var(--accent);font-size:10px">[pkg]</span>' : '') +
              '<div style="font-size:10px;color:var(--faint)">cost ' + (p.cost ? '$' + p.cost.toFixed(2) : '—') + ' · retail ' + (p.retail ? '$' + p.retail.toFixed(2) : '—') + '</div>';
            d.onmouseenter = function () { d.style.background = "var(--bg-alt)"; };
            d.onmouseleave = function () { d.style.background = ""; };
            d.onmousedown  = function (e) {
              e.preventDefault(); // prevent blur before click
              route[routeProp] = p.part_no;
              // Update badge
              var badge = $(slotId + "-badge");
              if (badge) badge.outerHTML =
                '<div id="' + slotId + '-badge" style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg-alt);border:1px solid var(--accent);border-radius:5px;font-size:11px;margin-bottom:4px">' +
                '<span style="flex:1"><strong>' + escHtml(p.part_no) + '</strong> — ' + escHtml(p.description) +
                  (p.isPackage ? ' <span style="color:var(--accent);font-size:10px">[pkg]</span>' : '') + '</span>' +
                '<button id="' + slotId + '-clear" style="background:none;border:none;color:var(--faint);cursor:pointer;font-size:14px;line-height:1;padding:0">×</button>' +
                '</div>';
              wireClear(slotId, routeProp);
              qEl.value = "";
              resEl.style.display = "none";
              refreshStats();
              if (window.refreshTakeoff) window.refreshTakeoff();
            };
            resEl.appendChild(d);
          });
        });
      }

      qEl.oninput = _deb ? _deb(function () { showResults(qEl.value); }, 250) : function () { showResults(qEl.value); };
      qEl.onfocus = function () { showResults(qEl.value); };
      qEl.onblur  = function () { setTimeout(function () { resEl.style.display = "none"; }, 150); };
    }

    function wireClear(slotId, routeProp) {
      var btn = $(slotId + "-clear"); if (!btn) return;
      btn.onclick = function () {
        route[routeProp] = null;
        var badge = $(slotId + "-badge");
        if (badge) badge.outerHTML = '<div id="' + slotId + '-badge" style="color:var(--faint);font-size:11px;margin-bottom:4px">None selected</div>';
        refreshStats();
        if (window.refreshTakeoff) window.refreshTakeoff();
      };
    }

    setupPicker("rte-str", "straightPkgId");
    setupPicker("rte-cor", "cornerPkgId");
    setupPicker("rte-tee", "teePkgId");
    wireClear("rte-str", "straightPkgId");
    wireClear("rte-cor", "cornerPkgId");
    wireClear("rte-tee", "teePkgId");

    var delBtn = $("rte-delete");
    if (delBtn) delBtn.onclick = function () {
      if (window.deleteSelected) window.deleteSelected();
      box.innerHTML = '<p style="color:var(--faint);padding:12px 8px;font-size:12px">Route deleted.</p>';
    };
  };

  // Wire tab clicks for new tabs once DOM ready
  function wireNewTabs() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.onclick = function () { window.switchTab(t.dataset.tab); };
    });
    renderCircuitsTable();
    initSidebarResize();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireNewTabs);
  else setTimeout(wireNewTabs, 800);

})();

