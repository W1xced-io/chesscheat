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
      "background:rgba(20,20,20,.85)",
      "color:#fff",
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "border:1px solid rgba(255,255,255,.12)",
      "border-radius:8px",
      "padding:8px",
      "min-width:150px",
      "backdrop-filter:blur(6px)",
      "user-select:none"
    ].join(";");

    root.innerHTML = `
      <div id="cc-drag" style="cursor:move;font-weight:600;font-size:11px;opacity:.8;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
        <span>Chesscheat</span><span style="font-weight:500">G: <span id="cc-toggle">ON</span></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <button id="cc-start" style="all:unset;cursor:pointer;background:#2f6fed;padding:4px 8px;border-radius:6px;font-size:11px">Start</button>
        <label style="font-size:11px;opacity:.85;display:flex;gap:4px;align-items:center">d<input id="cc-depth" type="number" min="1" max="30" value="${globalDepth}" style="width:40px;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:4px;padding:2px 4px;font-size:11px"></label>
      </div>
      <div id="cc-status" style="font-size:11px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">idle (G toggle)</div>
    `;

    document.documentElement.appendChild(root);

    const startBtn = root.querySelector("#cc-start");
    const depthInput = root.querySelector("#cc-depth");
    const drag = root.querySelector("#cc-drag");

    startBtn.addEventListener("click", () => {
      if (!running) {
        start();
        startBtn.textContent = "Stop";
        startBtn.style.background = "#444";
      } else {
        stop();
        clearHighlights();
        lastBestMove = "";
        startBtn.textContent = "Start";
        startBtn.style.background = "#2f6fed";
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
