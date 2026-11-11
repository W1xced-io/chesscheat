(function () {
  if (window.__chesscheatLoaded) return;
  window.__chesscheatLoaded = true;

  let globalDepth = 8;
  let engine = null;
  let pollId = null;
  let observer = null;
  let debounceId = null;
  let lastFen = "";
  let searchFen = "";
  let lastBestMove = "";
  let hintsEnabled = true;
  let running = false;

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

  function renderHighlights(bestMove) {
    clearHighlights();
    if (!hintsEnabled || !bestMove || bestMove.length < 4) return;
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

  function setStatus(text) {
    const el = document.getElementById("cc-status");
    if (el) el.textContent = text;
  }

  function setToggleLabel() {
    const el = document.getElementById("cc-toggle");
    if (el) el.textContent = hintsEnabled ? "ON" : "OFF";
    if (el) el.style.opacity = hintsEnabled ? "1" : "0.5";
  }

  function requestBestMove(fen) {
    if (!engine) return;
    searchFen = fen;
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
      if (data.startsWith("bestmove")) {
        if (lastFen !== searchFen) return;
        const bestMove = data.split(" ")[1] || "";
        if (!bestMove || bestMove === "(none)" || bestMove === "0000") return;
        lastBestMove = bestMove;
        setStatus(`best: ${bestMove}`);
        renderHighlights(bestMove);
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
    hintsEnabled = !hintsEnabled;
    setToggleLabel();
    const gui = document.getElementById("cc-mini-gui");
    if (gui) gui.style.display = hintsEnabled ? "block" : "none";
    if (!hintsEnabled) {
      clearHighlights();
    } else {
      renderHighlights(lastBestMove);
    }
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
      "width:240px",
      "height:140px",
      "min-width:180px",
      "min-height:120px",
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
      <div id="cc-status" style="font-size:.9em;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:6px;flex:0 0 auto">idle (G toggle)</div>
      <div id="cc-resize" title="Resize" style="position:absolute;right:4px;bottom:4px;width:14px;height:14px;cursor:nwse-resize;opacity:.7">
        <svg viewBox="0 0 10 10" width="14" height="14" aria-hidden="true"><path d="M9 1v8H1" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.5" stroke-linecap="round"/><path d="M9 5v4H5M9 8H8" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2" stroke-linecap="round"/></svg>
      </div>
    `;

    document.documentElement.appendChild(root);

    const startBtn = root.querySelector("#cc-start");
    const depthInput = root.querySelector("#cc-depth");
    const drag = root.querySelector("#cc-drag");

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
      const scale = Math.min(rect.width / 240, rect.height / 140);
      root.style.fontSize = `${Math.max(12, Math.min(22, 13 * scale))}px`;
    };
    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const w = Math.min(520, Math.max(180, startW + (e.clientX - startX)));
      const h = Math.min(420, Math.max(120, startH + (e.clientY - startY)));
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
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === "g" || e.key === "G") {
      toggleHints();
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
