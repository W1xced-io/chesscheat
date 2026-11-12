(() => {
  'use strict';

  if (window.__chesscheatLoaded) return;
  window.__chesscheatLoaded = true;

  const BRIDGE_ATTRIBUTE = 'data-chesscheat-engine-base';
  const BUNDLED_ENGINE = { script: 'stockfish-19-lite-single.js', wasm: 'stockfish-19-lite-single.wasm' };
  const ENGINE_URL = '/bundles/app/js/vendor/jschessengine/stockfish.asm.1abfa10c.js';
  const ENGINE_LOAD_TIMEOUT_MS = 15000;
  const DOM_SETTLE_MS = 120;
  const SAFETY_POLL_MS = 1000;
  const STORE_KEY = 'cc-settings-v1';

  const FILES = 'abcdefgh';
  const squareCode = (sq) => `${FILES.indexOf(sq[0]) + 1}${sq[1]}`;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : {};
    } catch (e) { return {}; }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        depth: globalDepth,
        flashKey,
        hideUntilKey,
        flashWhenGuiHidden
      }));
    } catch (e) {}
  }
  const saved = loadSettings();

  let globalDepth = Math.min(30, Math.max(1, parseInt(saved.depth, 10) || 15));
  let flashKey = (typeof saved.flashKey === 'string' && saved.flashKey) ? saved.flashKey : '`';
  let hideUntilKey = !!saved.hideUntilKey;
  let flashWhenGuiHidden = !!saved.flashWhenGuiHidden;

  let engine = null;
  let engineName = '';
  let engineReady = false;
  let running = false;
  let observer = null;
  let pollId = null;
  let debounceId = null;
  let domState = { grid: null, turn: 'w', ep: '-' };
  let lastPosKey = '';
  let searchPosKey = '';
  let searchFen = '';
  let lastBestMove = '';
  let lastPv = '';
  let lastScore = null;
  let lastDepth = 0;
  let lastPosInfo = null;
  let guiVisible = true;
  let flashTimer = null;
  let flashVisible = false;
  let capturingKey = false;

  function getBoard() {
    return document.querySelector('wc-chess-board');
  }

  function readPositionFromApi(board) {
    const game = board && board.game;
    if (!game || typeof game.getFEN !== 'function') return null;
    try {
      const fen = game.getFEN();
      const fields = typeof fen === 'string' ? fen.split(' ') : [];
      if (fields.length < 2) return null;
      let playingAs = null;
      if (typeof game.getPlayingAs === 'function') {
        const p = game.getPlayingAs();
        if (p === 1) playingAs = 'w';
        else if (p === 2) playingAs = 'b';
      }
      return { fen, turn: fields[1], playingAs, gameOver: typeof game.isGameOver === 'function' && !!game.isGameOver(), source: 'api' };
    } catch (e) { return null; }
  }

  function readGrid(board) {
    const grid = {};
    board.querySelectorAll('.piece').forEach((el) => {
      let piece = null, square = null;
      el.classList.forEach((cls) => {
        if (/^[wb][pnbrqk]$/.test(cls)) piece = cls;
        else if (/^square-[1-8][1-8]$/.test(cls)) square = cls.slice(7);
      });
      if (piece && square) grid[square] = piece;
    });
    return grid;
  }

  function placementFromGrid(grid) {
    const rows = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = '', empty = 0;
      for (let file = 1; file <= 8; file++) {
        const piece = grid[`${file}${rank}`];
        if (!piece) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += piece[0] === 'w' ? piece[1].toUpperCase() : piece[1];
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function castlingFromGrid(grid) {
    let rights = '';
    if (grid['51'] === 'wk') {
      if (grid['81'] === 'wr') rights += 'K';
      if (grid['11'] === 'wr') rights += 'Q';
    }
    if (grid['58'] === 'bk') {
      if (grid['88'] === 'br') rights += 'k';
      if (grid['18'] === 'br') rights += 'q';
    }
    return rights || '-';
  }

  function lastMoverFromHighlights(board, grid) {
    const highlights = board.querySelectorAll('.highlight:not(.cheat-highlight)');
    for (const el of highlights) {
      const cls = Array.from(el.classList).find((c) => /^square-[1-8][1-8]$/.test(c));
      const piece = cls && grid[cls.slice(7)];
      if (piece) return piece[0];
    }
    return null;
  }

  function enPassantSquare(previous, grid, changed) {
    for (const sq of changed) {
      const piece = grid[sq];
      if (!piece || piece[1] !== 'p') continue;
      const file = sq[0], fileLetter = FILES[Number(file) - 1];
      if (piece === 'wp' && sq[1] === '4' && previous[`${file}2`] === 'wp' && !grid[`${file}2`]) return `${fileLetter}3`;
      if (piece === 'bp' && sq[1] === '5' && previous[`${file}7`] === 'bp' && !grid[`${file}7`]) return `${fileLetter}6`;
    }
    return '-';
  }

  function readPositionFromDom(board, state) {
    const grid = readGrid(board);
    const pieces = Object.values(grid);
    if (!pieces.includes('wk') || !pieces.includes('bk')) return null;
    const changed = state.grid ? Object.keys({ ...state.grid, ...grid }).filter((sq) => state.grid[sq] !== grid[sq]) : [];
    let { turn, ep } = state;
    if (!state.grid || changed.length > 4) {
      turn = lastMoverFromHighlights(board, grid) === 'w' ? 'b' : 'w';
      ep = '-';
    } else if (changed.length > 0) {
      const mover = changed.map((sq) => grid[sq]).find(Boolean);
      if (mover) turn = mover[0] === 'w' ? 'b' : 'w';
      ep = enPassantSquare(state.grid, grid, changed);
    }
    state.grid = grid; state.turn = turn; state.ep = ep;
    return { fen: `${placementFromGrid(grid)} ${turn} ${castlingFromGrid(grid)} ${ep} 0 1`, turn, playingAs: null, gameOver: false, source: 'dom' };
  }

  function readPosition(board) {
    return readPositionFromApi(board) || readPositionFromDom(board, domState);
  }

  function sanFor(board, move) {
    try {
      const game = board && board.game;
      if (!game || typeof game.getLegalMoves !== 'function') return null;
      const legal = game.getLegalMoves();
      if (!Array.isArray(legal)) return null;
      const from = move.slice(0, 2), to = move.slice(2, 4), promotion = (move[4] || '').toLowerCase();
      const found = legal.find((m) => m.from === from && m.to === to && (!promotion || String(m.promotion || '').toLowerCase() === promotion));
      return found && found.san ? found.san : null;
    } catch (e) { return null; }
  }

  function clearHighlights() {
    document.querySelectorAll('.cheat-highlight').forEach((el) => el.remove());
  }

  function canShowHints() {
    return guiVisible || (hideUntilKey && flashWhenGuiHidden);
  }

  function isMyTurn() {
    if (!lastPosInfo || !lastPosInfo.playingAs) return true;
    return lastPosInfo.turn === lastPosInfo.playingAs;
  }

  function renderHighlights(bestMove) {
    clearHighlights();
    if (!canShowHints() || !bestMove || bestMove.length < 4) return;
    if (hideUntilKey && !flashVisible) return;
    if (!isMyTurn()) return;
    const board = getBoard();
    if (!board) return;
    const from = squareCode(bestMove.slice(0, 2));
    const to = squareCode(bestMove.slice(2, 4));
    [from, to].forEach((sq) => {
      const h = document.createElement('div');
      h.className = `highlight cheat-highlight square-${sq}`;
      h.style.background = 'rgba(235, 87, 87, 0.55)';
      h.style.pointerEvents = 'none';
      board.appendChild(h);
    });
  }

  function formatScore(score) {
    if (!score) return '';
    if (score.type === 'mate') return `M${score.value}`;
    const cp = score.value / 100;
    return (cp >= 0 ? '+' : '') + cp.toFixed(2);
  }

  function updateStatusDisplay() {
    const el = document.getElementById('cc-status');
    if (!el) return;
    if (!running) { el.textContent = 'stopped'; el.title = ''; return; }
    if (!engineReady) { el.textContent = 'loading engine...'; el.title = ''; return; }
    const parts = [];
    if (lastDepth) parts.push(`d${lastDepth}`);
    if (lastScore) parts.push(formatScore(lastScore));
    const mine = isMyTurn();
    if (!mine && lastPosInfo && lastPosInfo.playingAs) parts.push('opp');
    const showMove = guiVisible && (!hideUntilKey || flashVisible) && mine;
    if (lastBestMove) {
      if (showMove) {
        const board = getBoard();
        parts.push((board && sanFor(board, lastBestMove)) || lastBestMove);
      } else if (hideUntilKey || !mine) {
        parts.push(mine ? 'hidden' : 'wait');
      }
    } else {
      parts.push('thinking');
    }
    el.textContent = parts.join(' · ') || 'running';
    el.title = (lastPv || lastBestMove || '') + (engineName ? `\n${engineName}` : '');
  }

  function setStatus(text) {
    const el = document.getElementById('cc-status');
    if (el) { el.textContent = text; el.title = ''; }
  }

  function setToggleLabel() {
    const el = document.getElementById('cc-toggle');
    if (el) el.textContent = guiVisible ? 'ON' : 'OFF';
    if (el) el.style.opacity = guiVisible ? '1' : '0.5';
  }

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t);
    }
    return false;
  }

  function createBundledWorker() {
    const base = document.documentElement && document.documentElement.getAttribute(BRIDGE_ATTRIBUTE);
    if (!base) return Promise.reject(new Error('no bridge'));
    return fetch(base + BUNDLED_ENGINE.script).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }).then((code) => {
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      try {
        const worker = new Worker(`${blobUrl}#${encodeURIComponent(base + BUNDLED_ENGINE.wasm)}`);
        worker.addEventListener('error', () => URL.revokeObjectURL(blobUrl), { once: true });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        return worker;
      } catch (e) {
        URL.revokeObjectURL(blobUrl);
        throw e;
      }
    });
  }

  async function startEngine() {
    if (engine) return;
    engineReady = false;
    engineName = '';
    const sources = [
      { name: 'Stockfish 19 (bundled)', open: createBundledWorker },
      { name: "chess.com's Stockfish", open: () => new Worker(ENGINE_URL) }
    ];
    let lastErr = null;
    for (const src of sources) {
      let w;
      try {
        const opened = src.open();
        w = opened && typeof opened.then === 'function' ? await opened : opened;
      } catch (e) { lastErr = e; continue; }
      const ok = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; cleanup(); resolve(false); } }, ENGINE_LOAD_TIMEOUT_MS);
        const onMsg = (ev) => {
          const d = String(ev.data || '');
          if (!done && (d === 'uciok' || d.startsWith('id '))) { done = true; cleanup(); resolve(true); }
        };
        const onErr = () => { if (!done) { done = true; cleanup(); resolve(false); } };
        function cleanup() { clearTimeout(timer); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); }
        w.addEventListener('message', onMsg);
        w.addEventListener('error', onErr);
        try { w.postMessage('uci'); } catch (e) { done = true; cleanup(); resolve(false); }
      });
      if (ok) {
        engine = w;
        engineName = src.name;
        engineReady = true;
        engine.onmessage = onEngineMessage;
        engine.onerror = () => { if (running) setStatus('engine error'); };
        try { engine.postMessage('isready'); } catch (e) {}
        return;
      }
      try { w.terminate(); } catch (e) {}
      lastErr = lastErr || new Error('engine failed');
    }
    throw lastErr || new Error('no engine');
  }

  function onEngineMessage(event) {
    const data = String(event.data || '');
    if (data.startsWith('info ')) {
      if (lastPosKey !== searchPosKey) return;
      const d = data.match(/\bdepth (\d+)/);
      if (d) lastDepth = parseInt(d[1], 10);
      const sm = data.match(/\bscore mate (-?\d+)/);
      const sc = data.match(/\bscore cp (-?\d+)/);
      if (sm) lastScore = { type: 'mate', value: parseInt(sm[1], 10) };
      else if (sc) lastScore = { type: 'cp', value: parseInt(sc[1], 10) };
      const pv = data.match(/\bpv (.+)$/);
      if (pv) lastPv = pv[1].trim();
      if (lastDepth) updateStatusDisplay();
    } else if (data.startsWith('bestmove')) {
      if (lastPosKey !== searchPosKey) return;
      const bestMove = data.split(' ')[1] || '';
      if (!bestMove || bestMove === '(none)' || bestMove === '0000') return;
      lastBestMove = bestMove;
      renderHighlights(bestMove);
      updateStatusDisplay();
    }
  }

  function requestBestMove(fen, posKey) {
    if (!engine || !engineReady) return;
    searchFen = fen;
    searchPosKey = posKey;
    lastBestMove = '';
    lastPv = '';
    lastScore = null;
    lastDepth = 0;
    flashVisible = false;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    clearHighlights();
    updateStatusDisplay();
    try {
      engine.postMessage('stop');
      engine.postMessage(`position fen ${fen}`);
      engine.postMessage(`go depth ${globalDepth}`);
    } catch (e) {}
  }

  function checkPosition() {
    const board = getBoard();
    if (!board || !running) return;
    const pos = readPosition(board);
    if (!pos || !pos.fen) return;
    lastPosInfo = pos;
    if (pos.gameOver) { setStatus('game over'); return; }
    const key = pos.fen;
    if (key !== lastPosKey) {
      lastPosKey = key;
      requestBestMove(pos.fen, key);
    }
  }

  async function start() {
    if (running) return;
    const board = getBoard();
    if (!board) { setStatus('no board'); return; }
    running = true;
    domState = { grid: null, turn: 'w', ep: '-' };
    setStatus('loading engine...');
    try {
      await startEngine();
    } catch (e) {
      running = false;
      setStatus('engine err');
      return;
    }
    lastPosKey = '';
    lastPosInfo = null;
    checkPosition();
    pollId = setInterval(checkPosition, SAFETY_POLL_MS);
    try {
      observer = new MutationObserver(() => {
        clearTimeout(debounceId);
        debounceId = setTimeout(checkPosition, DOM_SETTLE_MS);
      });
      observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }

  function stop() {
    running = false;
    if (pollId) clearInterval(pollId);
    pollId = null;
    if (observer) { try { observer.disconnect(); } catch (e) {} }
    observer = null;
    if (debounceId) clearTimeout(debounceId);
    debounceId = null;
    if (engine) { try { engine.terminate(); } catch (e) {} }
    engine = null;
    engineReady = false;
    engineName = '';
    lastPosKey = '';
    searchPosKey = '';
    searchFen = '';
    lastBestMove = '';
    lastPv = '';
    lastScore = null;
    lastDepth = 0;
    lastPosInfo = null;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    flashVisible = false;
    clearHighlights();
    setStatus('stopped');
  }

  function toggleHints() {
    guiVisible = !guiVisible;
    setToggleLabel();
    const gui = document.getElementById('cc-mini-gui');
    if (gui) gui.style.display = guiVisible ? 'flex' : 'none';
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
    if (document.getElementById('cc-mini-gui')) return;
    const root = document.createElement('div');
    root.id = 'cc-mini-gui';
    root.style.cssText = [
      'position:fixed','top:16px','right:16px','z-index:2147483647',
      'width:250px','height:200px','min-width:190px','min-height:176px','max-width:520px','max-height:430px',
      'background:linear-gradient(160deg,rgba(26,28,34,.66),rgba(14,16,21,.60))','color:#eef2f8',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'border:1px solid rgba(255,255,255,.14)','border-radius:14px','padding:11px 12px 13px',
      'box-shadow:0 10px 30px rgba(0,0,0,.28), 0 1px 0 rgba(255,255,255,.06) inset',
      'backdrop-filter:blur(22px) saturate(150%)','-webkit-backdrop-filter:blur(22px) saturate(150%)',
      'user-select:none','box-sizing:border-box','overflow:hidden','display:flex','flex-direction:column','gap:9px'
    ].join(';');

    root.innerHTML = `
      <div id="cc-drag" style="cursor:move;font-weight:600;font-size:1em;letter-spacing:.2px;display:flex;justify-content:space-between;align-items:center;opacity:.95;flex:0 0 auto">
        <span>Chesscheat</span><span style="font-weight:500;font-size:.9em;opacity:.85">G: <span id="cc-toggle">ON</span></span>
      </div>
      <div id="cc-controls" style="display:flex;gap:8px;align-items:stretch;flex:1 1 auto;min-height:0">
        <button id="cc-start" style="all:unset;cursor:pointer;flex:1 1 0;background:linear-gradient(180deg,#3b82f6,#2b6ef0);padding:8px 10px;border-radius:9px;font-size:.95em;font-weight:600;letter-spacing:.2px;box-shadow:0 3px 10px rgba(43,110,240,.22), inset 0 1px 0 rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;text-align:center;transition:filter .12s ease, transform .06s ease">Start</button>
        <label style="font-size:.9em;opacity:.92;display:flex;gap:6px;align-items:center;justify-content:center;flex:0 0 auto;padding:0 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:9px">Depth<input id="cc-depth" type="number" min="1" max="30" value="${globalDepth}" style="width:3.5em;background:rgba(255,255,255,.07);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:4px 6px;font-size:1em;outline:none"></label>
      </div>
      <div id="cc-flash-row" style="display:flex;gap:8px;align-items:center;flex:0 0 auto;font-size:.85em">
        <button id="cc-flashkey" title="Click to set flash key" style="all:unset;cursor:pointer;flex:0 0 auto;padding:4px 8px;border-radius:7px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)">Flash: <span id="cc-flashkey-label"></span></button>
        <label style="display:flex;gap:6px;align-items:center;opacity:.9;cursor:pointer"><input id="cc-hide" type="checkbox" ${hideUntilKey ? 'checked' : ''} style="accent-color:#4a90ff">Hide until key</label>
      </div>
      <label id="cc-hide-gui-wrap" style="display:${hideUntilKey ? 'flex' : 'none'};gap:6px;align-items:center;flex:0 0 auto;font-size:.82em;opacity:.85;cursor:pointer;padding-left:6px"><input id="cc-hide-gui" type="checkbox" ${flashWhenGuiHidden ? 'checked' : ''} style="accent-color:#4a90ff">Work when GUI hidden (G)</label>
      <div id="cc-status" style="font-size:.9em;opacity:.94;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:7px 9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);border-radius:8px;flex:0 0 auto">idle (G toggle)</div>
      <div id="cc-resize" title="Resize" style="position:absolute;right:4px;bottom:4px;width:14px;height:14px;cursor:nwse-resize;opacity:.7">
        <svg viewBox="0 0 10 10" width="14" height="14" aria-hidden="true"><path d="M9 1v8H1" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.5" stroke-linecap="round"/><path d="M9 5v4H5M9 8H8" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2" stroke-linecap="round"/></svg>
      </div>
    `;

    document.documentElement.appendChild(root);

    const startBtn = root.querySelector('#cc-start');
    const depthInput = root.querySelector('#cc-depth');
    const drag = root.querySelector('#cc-drag');
    const flashKeyBtn = root.querySelector('#cc-flashkey');
    const flashKeyLabel = root.querySelector('#cc-flashkey-label');
    const hideCb = root.querySelector('#cc-hide');
    const hideGuiCb = root.querySelector('#cc-hide-gui');
    const hideGuiWrap = root.querySelector('#cc-hide-gui-wrap');

    const updateHideGuiOption = () => { if (hideGuiWrap) hideGuiWrap.style.display = hideUntilKey ? 'flex' : 'none'; };
    updateHideGuiOption();
    const updateFlashKeyLabel = () => {
      if (!flashKeyLabel) return;
      flashKeyLabel.textContent = capturingKey ? 'press key...' : (flashKey === ' ' ? 'Space' : flashKey);
      if (flashKeyBtn) flashKeyBtn.style.background = capturingKey ? 'rgba(59,130,246,.35)' : 'rgba(255,255,255,.06)';
    };
    updateFlashKeyLabel();
    if (flashKeyBtn) flashKeyBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      capturingKey = !capturingKey; updateFlashKeyLabel();
    });
    window.addEventListener('mousedown', (e) => {
      if (!capturingKey) return;
      if (e.target && e.target.closest && e.target.closest('#cc-flashkey')) return;
      capturingKey = false; updateFlashKeyLabel();
    }, true);

    if (hideCb) hideCb.addEventListener('change', () => {
      hideUntilKey = !!hideCb.checked;
      if (!hideUntilKey) { flashVisible = false; if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; } flashWhenGuiHidden = false; if (hideGuiCb) hideGuiCb.checked = false; }
      updateHideGuiOption();
      renderHighlights(lastBestMove);
      updateStatusDisplay();
      saveSettings();
    });
    if (hideGuiCb) hideGuiCb.addEventListener('change', () => {
      flashWhenGuiHidden = !!hideGuiCb.checked;
      saveSettings();
    });

    startBtn.addEventListener('mouseenter', () => { startBtn.style.filter = 'brightness(1.08)'; });
    startBtn.addEventListener('mouseleave', () => { startBtn.style.filter = ''; });
    startBtn.addEventListener('mousedown', () => { startBtn.style.transform = 'scale(.985)'; });
    startBtn.addEventListener('mouseup', () => { startBtn.style.transform = ''; });
    startBtn.addEventListener('click', async () => {
      if (!running) {
        startBtn.textContent = '...';
        await start();
        if (running) {
          startBtn.textContent = 'Stop';
          startBtn.style.background = 'linear-gradient(180deg,#4a505e,#3a3f4b)';
          startBtn.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.06)';
        } else {
          startBtn.textContent = 'Start';
        }
      } else {
        stop();
        startBtn.textContent = 'Start';
        startBtn.style.background = 'linear-gradient(180deg,#3b82f6,#2b6ef0)';
        startBtn.style.boxShadow = '0 3px 10px rgba(43,110,240,.22), inset 0 1px 0 rgba(255,255,255,.12)';
      }
    });

    depthInput.addEventListener('change', () => {
      const v = parseInt(depthInput.value, 10);
      if (!isNaN(v)) globalDepth = Math.min(30, Math.max(1, v));
      depthInput.value = String(globalDepth);
      saveSettings();
    });

    let dragging = false, offX = 0, offY = 0;
    drag.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#cc-resize')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      offX = e.clientX - rect.left; offY = e.clientY - rect.top;
      root.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (dragging) {
        root.style.left = `${Math.max(0, e.clientX - offX)}px`;
        root.style.top = `${Math.max(0, e.clientY - offY)}px`;
      }
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    const resizeHandle = root.querySelector('#cc-resize');
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    const updateScale = () => {
      const rect = root.getBoundingClientRect();
      const scale = Math.min(rect.width / 250, rect.height / 200);
      root.style.fontSize = `${Math.max(12, Math.min(22, 13 * scale))}px`;
    };
    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true; dragging = false;
      const rect = root.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startW = rect.width; startH = rect.height;
      root.style.right = 'auto'; root.style.left = `${rect.left}px`; root.style.top = `${rect.top}px`;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      root.style.width = `${Math.min(520, Math.max(190, startW + (e.clientX - startX)))}px`;
      root.style.height = `${Math.min(430, Math.max(176, startH + (e.clientY - startY)))}px`;
      updateScale();
    });
    window.addEventListener('mouseup', () => { resizing = false; });
    updateScale();
    setToggleLabel();
  }

  window.addEventListener('keydown', (e) => {
    if (capturingKey) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') {
        capturingKey = false;
        const lbl = document.getElementById('cc-flashkey-label');
        const btn = document.getElementById('cc-flashkey');
        if (lbl) lbl.textContent = flashKey === ' ' ? 'Space' : flashKey;
        if (btn) btn.style.background = 'rgba(255,255,255,.06)';
        if (e.key === 'Escape') return;
      } else {
        flashKey = e.key; saveSettings();
        capturingKey = false;
        const lbl = document.getElementById('cc-flashkey-label');
        const btn = document.getElementById('cc-flashkey');
        if (lbl) lbl.textContent = flashKey === ' ' ? 'Space' : flashKey;
        if (btn) btn.style.background = 'rgba(255,255,255,.06)';
        return;
      }
    }
    if (isTypingTarget(e.target)) return;
    if (e.key === 'g' || e.key === 'G') { toggleHints(); return; }
    if (e.key === flashKey) { e.preventDefault(); flashMove(); }
  }, true);

  function init() { createGui(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
