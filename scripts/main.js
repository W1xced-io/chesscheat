(function () {
  if (window.__chesscheatLoaded) return;
  window.__chesscheatLoaded = true;

  const STORE_KEY = "cc-settings-v1";
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      const d = JSON.parse(raw);
      return d && typeof d === "object" ? d : {};
    } catch (e) { return {}; }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        depth: globalDepth,
        flashKey: flashKey,
        hideUntilKey: hideUntilKey,
        flashWhenGuiHidden: flashWhenGuiHidden
      }));
    } catch (e) {}
  }
  const saved = loadSettings();

  let globalDepth = Math.min(30, Math.max(1, parseInt(saved.depth, 10) || 8));
  let flashKey = (typeof saved.flashKey === "string" && saved.flashKey) ? saved.flashKey : "`";
  let hideUntilKey = !!saved.hideUntilKey;
  let flashWhenGuiHidden = !!saved.flashWhenGuiHidden;
  let engine = null;
  let pollId = null;
  let observer = null;
  let debounceId = null;
  let lastFen = "";
  let searchFen = "";
  let lastBestMove = "";
  let lastPv = "";
  let lastScore = null;
  let lastDepth = 0;
  let guiVisible = true;
  let running = false;
  let flashTimer = null;
  let flashVisible = false;
  let capturingKey = false;

  function getBoard() {
    return document.querySelector("wc-chess-board");
  }

  function getFenString() {
    let fen = "";
    for (let i = 8; i >= 1; i--) {
      for (let j = 1; j <= 8; j++) {
        const position = `${j}${i}`;
        if (j === 1 && i !== 8) fen += "/";
        const pieceEl = document.querySelector(`.piece.square-${position}`);
        let piece = null;
        if (pieceEl) {
          for (const item of pieceEl.classList.values()) {
            if (/^[wb][pnbrqk]$/i.test(item)) { piece = item.toLowerCase(); break; }
          }
        }
        if (!piece) {
          const prev = fen.slice(-1);
          if (prev && !isNaN(Number(prev))) {
            fen = fen.slice(0, -1) + String(Number(prev) + 1);
          } else {
            fen += "1";
          }
        } else if (piece[0] === "b") {
          fen += piece[1];
        } else if (piece[0] === "w") {
          fen += piece[1].toUpperCase();
        }
      }
    }
    return fen;
  }

  function clearHighlights() {
    document.querySelectorAll(".cheat-highlight").forEach((el) => el.remove());
  }

  function canShowHints() {
    return guiVisible || (hideUntilKey && flashWhenGuiHidden);
  }

  function renderHighlights(bestMove) {
    clearHighlights();
    if (!canShowHints() || !bestMove || bestMove.length < 4) return;
    if (hideUntilKey && !flashVisible) return;
    const board = getBoard();
    if (!board) return;
    const map = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    const from = `${map[bestMove[0]]}${bestMove[1]}`;
    const to = `${map[bestMove[2]]}${bestMove[3]}`;
    [from, to].forEach((sq) => {
      const h = document.createElement("div");
      h.className = `highlight cheat-highlight square-${sq}`;
      h.style.background = "rgba(235, 87, 87, 0.55)";
      h.style.pointerEvents = "none";
      board.appendChild(h);
    });
  }

  function formatScore(score) {
    if (!score) return "";
    if (score.type === "mate") return `M${score.value}`;
    const cp = (score.value / 100);
    return (cp >= 0 ? "+" : "") + cp.toFixed(2);
  }

  function uciToSan(fen, uci) {
    if (!fen || !uci || uci.length < 4) return uci || "";
    const files = "abcdefgh";
    const board = Array.from({ length: 8 }, () => Array(8).fill(""));
    const parts = fen.split(" ");
    const rows = parts[0].split("/");
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rows[r] || "") {
        if (ch >= "1" && ch <= "8") c += parseInt(ch, 10);
        else if (c < 8) { board[r][c] = ch; c++; }
      }
    }
    const fromFile = files.indexOf(uci[0]);
    const fromRank = 8 - parseInt(uci[1], 10);
    const toFile = files.indexOf(uci[2]);
    const toRank = 8 - parseInt(uci[3], 10);
    if (fromFile < 0 || toFile < 0 || fromRank < 0 || toRank < 0) return uci;
    const piece = board[fromRank][fromFile];
    if (!piece) return uci;
    const target = board[toRank][toFile];
    const isCapture = !!target || (piece.toLowerCase() === "p" && fromFile !== toFile);
    const promo = uci[4] ? "=" + uci[4].toUpperCase() : "";
    const upper = piece.toUpperCase();
    if (upper === "K" && Math.abs(fromFile - toFile) === 2) {
      return toFile > fromFile ? "O-O" : "O-O-O";
    }
    if (upper === "P") {
      if (isCapture) return files[fromFile] + "x" + files[toFile] + (8 - toRank) + promo;
      return files[toFile] + (8 - toRank) + promo;
    }
    const letter = upper;
    let disamb = "";
    const movers = [];
    const dir = (piece === piece.toUpperCase()) ? 1 : -1;
    function add(r,c){ if(r>=0&&r<8&&c>=0&&c<8) movers.push([r,c]); }
    function slide(dirs){ dirs.forEach(([dr,dc])=>{ for(let i=1;i<8;i++){const r=fromRank+dr*i,c=fromFile+dc*i; if(r<0||r>7||c<0||c>7) break; const q=board[r][c]; if(!q) continue; if(q===piece) add(r,c); break; } }); }
    if (letter === "N") {
      [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc])=>{const r=toRank-dr,c=toFile-dc; if(r>=0&&r<8&&c>=0&&c<8&&board[r][c]===piece&&(r!==fromRank||c!==fromFile)) add(r,c);});
    } else if (letter === "B") {
      slide([[1,1],[1,-1],[-1,1],[-1,-1]]);
    } else if (letter === "R") {
      slide([[1,0],[-1,0],[0,1],[0,-1]]);
    } else if (letter === "Q") {
      slide([[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]);
    } else if (letter === "K") {
      [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{const r=toRank-dr,c=toFile-dc; if(r>=0&&r<8&&c>=0&&c<8&&board[r][c]===piece&&(r!==fromRank||c!==fromFile)) add(r,c);});
    }
    if (movers.length) {
      const sameFile = movers.some(([r,c]) => c === fromFile);
      const sameRank = movers.some(([r,c]) => r === fromRank);
      if (!sameFile) disamb = files[fromFile];
      else if (!sameRank) disamb = String(8 - fromRank);
      else disamb = files[fromFile] + String(8 - fromRank);
    }
    return letter + disamb + (isCapture ? "x" : "") + files[toFile] + (8 - toRank) + promo;
  }

  function updateStatusDisplay() {
    const el = document.getElementById("cc-status");
    if (!el) return;
    if (!running) { el.textContent = "stopped"; return; }
    if (!lastBestMove) { el.textContent = `running d${globalDepth}`; return; }
    const san = uciToSan(searchFen || lastFen, lastBestMove);
    const showMove = guiVisible && (!hideUntilKey || flashVisible);
    const parts = [];
    if (lastDepth) parts.push(`d${lastDepth}`);
    if (lastScore) parts.push(formatScore(lastScore));
    if (showMove) parts.push(san);
    else if (hideUntilKey) parts.push("hidden");
    el.textContent = parts.join(" · ") || "running";
    el.title = lastPv || lastBestMove || "";
  }

  function setStatus(text) {
    const el = document.getElementById("cc-status");
    if (el) { el.textContent = text; el.title = ""; }
  }

  function setToggleLabel() {
    const el = document.getElementById("cc-toggle");
    if (el) el.textContent = guiVisible ? "ON" : "OFF";
    if (el) el.style.opacity = guiVisible ? "1" : "0.5";
  }

  function requestBestMove(fen) {
    if (!engine) return;
    searchFen = fen;
    lastBestMove = "";
    lastPv = "";
    lastScore = null;
    lastDepth = 0;
    flashVisible = false;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    clearHighlights();
    updateStatusDisplay();
    engine.postMessage("stop");
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage(`go movetime 150 depth ${globalDepth}`);
  }

  function stop() {
    running = false;
    if (pollId) clearInterval(pollId);
    pollId = null;
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
    }
    observer = null;
    if (debounceId) clearTimeout(debounceId);
    debounceId = null;
    if (engine) {
      try { engine.terminate(); } catch (e) {}
    }
    engine = null;
    lastFen = "";
    searchFen = "";
    lastBestMove = "";
    lastPv = "";
    lastScore = null;
    lastDepth = 0;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    flashVisible = false;
    setStatus("stopped");
  }

  function checkPosition() {
    const b = getBoard();
    if (!b || !running) return;
    const p = b.classList.contains("flipped") ? "b" : "w";
    const fen = `${getFenString()} ${p}`;
    if (fen !== lastFen) {
      lastFen = fen;
      requestBestMove(fen);
    }
  }

  function start() {
    const board = getBoard();
    if (!board) {
      setStatus("no board");
      return;
    }
    if (running) return;
    running = true;
    lastFen = `${getFenString()} ${board.classList.contains("flipped") ? "b" : "w"}`;
    try {
      engine = new Worker("/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js");
    } catch (e) {
      setStatus("engine err");
      running = false;
      return;
    }
    engine.onmessage = (event) => {
      const data = String(event.data || "");
      if (data.startsWith("info ")) {
        if (lastFen !== searchFen) return;
        const d = data.match(/\bdepth (\d+)/);
        if (d) lastDepth = parseInt(d[1], 10);
        const sm = data.match(/\bscore mate (-?\d+)/);
        const sc = data.match(/\bscore cp (-?\d+)/);
        if (sm) lastScore = { type: "mate", value: parseInt(sm[1], 10) };
        else if (sc) lastScore = { type: "cp", value: parseInt(sc[1], 10) };
        const pv = data.match(/\bpv (.+)$/);
        if (pv) lastPv = pv[1].trim();
        if (lastDepth) updateStatusDisplay();
      } else if (data.startsWith("bestmove")) {
        if (lastFen !== searchFen) return;
        const bestMove = data.split(" ")[1] || "";
        if (!bestMove || bestMove === "(none)" || bestMove === "0000") return;
        lastBestMove = bestMove;
        renderHighlights(bestMove);
        updateStatusDisplay();
      }
    };
    setStatus("running");
    requestBestMove(lastFen);
    pollId = setInterval(checkPosition, 1000);
    try {
      observer = new MutationObserver(() => {
        clearTimeout(debounceId);
        debounceId = setTimeout(checkPosition, 50);
      });
      observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    } catch (e) {}
  }

  function toggleHints() {
    guiVisible = !guiVisible;
    setToggleLabel();
    const gui = document.getElementById("cc-mini-gui");
    if (gui) gui.style.display = guiVisible ? "flex" : "none";
    if (!guiVisible) {
      if (!(hideUntilKey && flashWhenGuiHidden)) {
        if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
        flashVisible = false;
        clearHighlights();
      }
    } else {
      renderHighlights(lastBestMove);
    }
    updateStatusDisplay();
  }

  function flashMove() {
    if (!canShowHints() || !lastBestMove) return;
    flashVisible = true;
    renderHighlights(lastBestMove);
    updateStatusDisplay();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashVisible = false;
      flashTimer = null;
      if (hideUntilKey) clearHighlights();
      updateStatusDisplay();
    }, 700);
  }

  function createGui() {
    if (document.getElementById("cc-mini-gui")) return;
    const root = document.createElement("div");
    root.id = "cc-mini-gui";
    root.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "width:250px",
      "height:198px",
      "min-width:190px",
      "min-height:175px",
      "max-width:520px",
      "max-height:420px",
      "background:linear-gradient(180deg,rgba(34,36,42,.72),rgba(18,19,23,.68))",
      "color:#f5f7fb",
      "font:13px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "border:1px solid rgba(255,255,255,.16)",
      "border-radius:12px",
      "padding:10px 10px 12px",
      "box-shadow:0 12px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08)",
      "backdrop-filter:blur(18px) saturate(140%)",
      "-webkit-backdrop-filter:blur(18px) saturate(140%)",
      "user-select:none",
      "box-sizing:border-box",
      "overflow:hidden",
      "display:flex",
      "flex-direction:column",
      "gap:8px"
    ].join(";");

    root.innerHTML = `
      <div id="cc-drag" style="cursor:move;font-weight:600;font-size:1em;letter-spacing:.2px;display:flex;justify-content:space-between;align-items:center;opacity:.95;flex:0 0 auto">
        <span>Chesscheat</span><span style="font-weight:500;font-size:.9em;opacity:.85">G: <span id="cc-toggle">ON</span></span>
      </div>
      <div id="cc-controls" style="display:flex;gap:8px;align-items:stretch;flex:1 1 auto;min-height:0">
        <button id="cc-start" style="all:unset;cursor:pointer;flex:1 1 0;background:linear-gradient(180deg,#3b82f6,#2563eb);padding:8px 10px;border-radius:8px;font-size:.95em;font-weight:600;box-shadow:0 2px 8px rgba(37,99,235,.35);display:flex;align-items:center;justify-content:center;text-align:center">Start</button>
        <label style="font-size:.9em;opacity:.9;display:flex;gap:6px;align-items:center;justify-content:center;flex:0 0 auto;padding:0 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px">Depth<input id="cc-depth" type="number" min="1" max="30" value="${globalDepth}" style="width:3.5em;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 6px;font-size:1em;outline:none"></label>
      </div>
      <div id="cc-flash-row" style="display:flex;gap:8px;align-items:center;flex:0 0 auto;font-size:.85em">
        <button id="cc-flashkey" title="Click to set flash key" style="all:unset;cursor:pointer;flex:0 0 auto;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)">Flash: <span id="cc-flashkey-label"></span></button>
        <label style="display:flex;gap:6px;align-items:center;opacity:.9;cursor:pointer"><input id="cc-hide" type="checkbox" ${hideUntilKey ? "checked" : ""} style="accent-color:#3b82f6">Hide until key</label>
      </div>
      <label id="cc-hide-gui-wrap" style="display:${hideUntilKey ? "flex" : "none"};gap:6px;align-items:center;flex:0 0 auto;font-size:.82em;opacity:.85;cursor:pointer;padding-left:6px"><input id="cc-hide-gui" type="checkbox" ${flashWhenGuiHidden ? "checked" : ""} style="accent-color:#3b82f6">Work when GUI hidden (G)</label>
      <div id="cc-status" style="font-size:.9em;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:6px;flex:0 0 auto">idle (G toggle)</div>
      <div id="cc-resize" title="Resize" style="position:absolute;right:4px;bottom:4px;width:14px;height:14px;cursor:nwse-resize;opacity:.7">
        <svg viewBox="0 0 10 10" width="14" height="14" aria-hidden="true"><path d="M9 1v8H1" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.5" stroke-linecap="round"/><path d="M9 5v4H5M9 8H8" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2" stroke-linecap="round"/></svg>
      </div>
    `;

    document.documentElement.appendChild(root);

    const startBtn = root.querySelector("#cc-start");
    const depthInput = root.querySelector("#cc-depth");
    const drag = root.querySelector("#cc-drag");
    const flashKeyBtn = root.querySelector("#cc-flashkey");
    const flashKeyLabel = root.querySelector("#cc-flashkey-label");
    const hideCb = root.querySelector("#cc-hide");
    const hideGuiCb = root.querySelector("#cc-hide-gui");
    const hideGuiWrap = root.querySelector("#cc-hide-gui-wrap");
    const updateHideGuiOption = () => { if (hideGuiWrap) hideGuiWrap.style.display = hideUntilKey ? "flex" : "none"; };
    updateHideGuiOption();
    const updateFlashKeyLabel = () => {
      if (!flashKeyLabel) return;
      flashKeyLabel.textContent = capturingKey ? "press key..." : (flashKey === " " ? "Space" : flashKey);
      if (flashKeyBtn) flashKeyBtn.style.background = capturingKey ? "rgba(59,130,246,.35)" : "rgba(255,255,255,.06)";
    };
    updateFlashKeyLabel();
    if (flashKeyBtn) flashKeyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      capturingKey = !capturingKey;
      updateFlashKeyLabel();
    });
    window.addEventListener("mousedown", (e) => {
      if (!capturingKey) return;
      if (e.target && e.target.closest && e.target.closest("#cc-flashkey")) return;
      capturingKey = false;
      updateFlashKeyLabel();
    }, true);
    if (hideCb) hideCb.addEventListener("change", () => {
      hideUntilKey = !!hideCb.checked;
      if (!hideUntilKey) { flashVisible = false; if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; } flashWhenGuiHidden = false; if (hideGuiCb) hideGuiCb.checked = false; }
      updateHideGuiOption();
      renderHighlights(lastBestMove);
      updateStatusDisplay();
      saveSettings();
    });
    if (hideGuiCb) hideGuiCb.addEventListener("change", () => {
      flashWhenGuiHidden = !!hideGuiCb.checked;
      saveSettings();
    });

    startBtn.addEventListener("click", () => {
      if (!running) {
        start();
        startBtn.textContent = "Stop";
        startBtn.style.background = "linear-gradient(180deg,#525866,#3f4552)";
        startBtn.style.boxShadow = "none";
      } else {
        stop();
        clearHighlights();
        lastBestMove = "";
        startBtn.textContent = "Start";
        startBtn.style.background = "linear-gradient(180deg,#3b82f6,#2563eb)";
        startBtn.style.boxShadow = "0 2px 8px rgba(37,99,235,.35)";
      }
    });

    depthInput.addEventListener("change", () => {
      const v = parseInt(depthInput.value, 10);
      if (!isNaN(v)) globalDepth = Math.min(30, Math.max(1, v));
      depthInput.value = String(globalDepth);
      saveSettings();
    });

    let dragging = false;
    let offX = 0;
    let offY = 0;
    drag.addEventListener("mousedown", (e) => {
      if (e.target && e.target.closest && e.target.closest("#cc-resize")) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      root.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      root.style.left = `${Math.max(0, e.clientX - offX)}px`;
      root.style.top = `${Math.max(0, e.clientY - offY)}px`;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });

    const resizeHandle = root.querySelector("#cc-resize");
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    resizeHandle.addEventListener("mousedown", (e) => {
      resizing = true;
      dragging = false;
      const rect = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      root.style.right = "auto";
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      e.preventDefault();
      e.stopPropagation();
    });
    const updateScale = () => {
      const rect = root.getBoundingClientRect();
      const scale = Math.min(rect.width / 250, rect.height / 198);
      root.style.fontSize = `${Math.max(12, Math.min(22, 13 * scale))}px`;
    };
    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const w = Math.min(520, Math.max(180, startW + (e.clientX - startX)));
      const h = Math.min(420, Math.max(175, startH + (e.clientY - startY)));
      root.style.width = `${w}px`;
      root.style.height = `${h}px`;
      updateScale();
    });
    window.addEventListener("mouseup", () => {
      resizing = false;
    });
    updateScale();

    setToggleLabel();
  }

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(t);
    }
    return false;
  }

  window.addEventListener("keydown", (e) => {
    if (capturingKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" || e.key === "g" || e.key === "G") {
        capturingKey = false;
        const lbl = document.getElementById("cc-flashkey-label");
        const btn = document.getElementById("cc-flashkey");
        if (lbl) lbl.textContent = flashKey === " " ? "Space" : flashKey;
        if (btn) btn.style.background = "rgba(255,255,255,.06)";
        if (e.key === "Escape") return;
      } else {
        flashKey = e.key;
        saveSettings();
        capturingKey = false;
        const lbl = document.getElementById("cc-flashkey-label");
        const btn = document.getElementById("cc-flashkey");
        if (lbl) lbl.textContent = flashKey === " " ? "Space" : flashKey;
        if (btn) btn.style.background = "rgba(255,255,255,.06)";
        return;
      }
    }
    if (isTypingTarget(e.target)) return;
    if (e.key === "g" || e.key === "G") {
      toggleHints();
      return;
    }
    if (e.key === flashKey) {
      e.preventDefault();
      flashMove();
    }
  }, true);

  function init() {
    createGui();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
