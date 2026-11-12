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
        multiPv,
        flashKey,
        hideUntilKey,
        flashWhenGuiHidden
      }));
    } catch (e) {}
  }
  const saved = loadSettings();

  let globalDepth = Math.min(30, Math.max(1, parseInt(saved.depth, 10) || 15));
  let multiPv = Math.min(5, Math.max(1, parseInt(saved.multiPv, 10) || 1));
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
  let searchToken = 0;
  let searchFen = '';
  let lastBestMove = '';
  let lastPv = '';
  let lastScore = null;
  let lastDepth = 0;
  let lastPvLines = [];
  let multiPvIdx = 0;
  let lastPosInfo = null;
  let guiVisible = true;
  let flashTimer = null;
  let flashVisible = false;
  let capturingKey = false;
  let overlayRoot = null;
  let overlayFlipped = false;

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
      if (piece && square) grid[square] = piece[0] === 'w' ? piece[1].toUpperCase() : piece[1];
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
        row += piece;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function castlingFromGrid(grid) {
    let rights = '';
    if (grid['51'] === 'K') {
      if (grid['81'] === 'R') rights += 'K';
      if (grid['11'] === 'R') rights += 'Q';
    }
    if (grid['58'] === 'k') {
      if (grid['88'] === 'r') rights += 'k';
      if (grid['18'] === 'r') rights += 'q';
    }
    return rights || '-';
  }

  function lastMoverFromHighlights(board, grid) {
    const highlights = board.querySelectorAll('.highlight');
    for (const el of highlights) {
      const cls = Array.from(el.classList).find((c) => /^square-[1-8][1-8]$/.test(c));
      const piece = cls && grid[cls.slice(7)];
      if (piece) return piece === piece.toUpperCase() ? 'w' : 'b';
    }
    return null;
  }

  function enPassantSquare(previous, grid, changed) {
    for (const sq of changed) {
      const piece = grid[sq];
      if (!piece || piece.toLowerCase() !== 'p') continue;
      const file = sq[0], fileLetter = FILES[Number(file) - 1];
      if (piece === 'P' && sq[1] === '4' && previous[`${file}2`] === 'P' && !grid[`${file}2`]) return `${fileLetter}3`;
      if (piece === 'p' && sq[1] === '5' && previous[`${file}7`] === 'p' && !grid[`${file}7`]) return `${fileLetter}6`;
    }
    return '-';
  }

  function readPositionFromDom(board, state) {
    const grid = readGrid(board);
    const pieces = Object.values(grid);
    if (!pieces.includes('K') || !pieces.includes('k')) return null;
    const changed = state.grid ? Object.keys({ ...state.grid, ...grid }).filter((sq) => state.grid[sq] !== grid[sq]) : [];
    let { turn, ep } = state;
    if (!state.grid || changed.length > 4) {
      turn = lastMoverFromHighlights(board, grid) === 'w' ? 'b' : 'w';
      ep = '-';
    } else if (changed.length > 0) {
      const mover = changed.map((sq) => grid[sq]).find(Boolean);
      if (mover) turn = mover === mover.toUpperCase() ? 'b' : 'w';
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

  function sendDesktopState() {
    try {
      const board = getBoard();
      const grid = board ? readGrid(board) : {};
      const fenPlacement = placementFromGrid(grid);
      const score = lastScore ? (lastScore.type === 'mate' ? { type: 'mate', value: lastScore.value } : { type: 'cp', value: lastScore.value }) : null;
      const payload = JSON.stringify({ fen: fenPlacement, grid, best: lastBestMove || '', score, depth: lastDepth || 0, status: !running ? 'stopped' : (!lastBestMove ? 'thinking' : 'best: ' + lastBestMove) });
      fetch('http://127.0.0.1:43117/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, mode: 'cors' }).catch(() => {});
    } catch (e) {}
  }

  function publishOverlayState() {
    try {
      const board = getBoard();
      const pos = board ? readPosition(board) : null;
      const grid = board ? readGrid(board) : {};
      const score = lastScore ? (lastScore.type === 'mate' ? { type: 'mate', value: lastScore.value } : { type: 'cp', value: lastScore.value }) : null;
      localStorage.setItem('cc-ov-state', JSON.stringify({
        grid,
        best: lastBestMove || '',
        score,
        depth: lastDepth || 0,
        status: !running ? 'stopped' : (!lastBestMove ? 'thinking' : 'best: ' + lastBestMove)
      }));
      sendDesktopState();
    } catch (e) {}
  }

  function renderHighlights(bestMove) {
    publishOverlayState();
    renderOverlayBoard();
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
    const mine = isMyTurn();
    if (!mine && lastPosInfo && lastPosInfo.playingAs) parts.push('opp');
    const showMove = guiVisible && (!hideUntilKey || flashVisible) && mine;
    if (multiPv > 1 && lastPvLines.length) {
      const i = multiPvIdx;
      const line = lastPvLines[i] || lastPvLines[0];
      if (line) {
        parts.push(formatScore(line.score));
        if (showMove) parts.push(`${i + 1}/${multiPv}: ${line.move}`);
      }
    } else if (lastScore) {
      parts.push(formatScore(lastScore));
    }
    if (lastBestMove) {
      if (showMove && multiPv === 1) {
        const board = getBoard();
        parts.push((board && sanFor(board, lastBestMove)) || lastBestMove);
      } else if ((hideUntilKey || !mine) && multiPv === 1) {
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
    const token = searchToken;
    if (data.startsWith('info ')) {
      if (token !== searchToken || lastPosKey !== searchPosKey) return;
      const d = data.match(/\bdepth (\d+)/);
      if (d) lastDepth = parseInt(d[1], 10);
      const sm = data.match(/\bscore mate (-?\d+)/);
      const sc = data.match(/\bscore cp (-?\d+)/);
      if (sm) lastScore = { type: 'mate', value: parseInt(sm[1], 10) };
      else if (sc) lastScore = { type: 'cp', value: parseInt(sc[1], 10) };
      const mp = data.match(/\bmultipv (\d+)/);
      const pv = data.match(/\bpv (.+)$/);
      if (pv && lastScore && lastDepth) {
        const idx = mp ? parseInt(mp[1], 10) : 1;
        lastPvLines[idx - 1] = { move: pv[1].trim().split(' ')[0], score: lastScore };
        if (idx === 1) lastPv = pv[1].trim();
        if (idx === multiPv) lastPvLines.length = multiPv;
      }
      if (lastDepth) updateStatusDisplay();
    } else if (data.startsWith('bestmove')) {
      if (token !== searchToken || lastPosKey !== searchPosKey) return;
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
    searchToken += 1;
    lastBestMove = '';
    lastPv = '';
    lastPvLines = [];
    lastScore = null;
    lastDepth = 0;
    multiPvIdx = 0;
    flashVisible = false;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    clearHighlights();
    updateStatusDisplay();
    try {
      engine.postMessage('stop');
      engine.postMessage(`setoption name MultiPV value ${multiPv}`);
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
    publishOverlayState();
    renderOverlayBoard();
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
    publishOverlayState();
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

  function createOverlay() {
    if (overlayRoot) { overlayRoot.style.display = 'flex'; return; }
    overlayRoot = document.createElement('div');
    overlayRoot.id = 'cc-overlay';
    overlayRoot.style.cssText = [
      'position:fixed','inset:0','z-index:2147483645',
      'background:radial-gradient(120% 120% at 50% 0%, rgba(10,12,16,.72), rgba(6,8,11,.92))',
      'color:#eef2f8','font:14px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'user-select:none','box-sizing:border-box','display:none','flex-direction:column','align-items:center','justify-content:center','gap:14px','padding:20px',
      'backdrop-filter:blur(10px) saturate(140%)','-webkit-backdrop-filter:blur(10px) saturate(140%)'
    ].join(';');
    overlayRoot.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;width:min(94vmin,620px)">
        <span style="font-weight:700;letter-spacing:.3px;font-size:1.15em">Chesscheat Overlay</span>
        <div style="display:flex;gap:8px">
          <button id="cc-ov-flip" title="Flip board" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);font-size:12px">Flip</button>
          <button id="cc-ov-close" title="Close overlay (O)" style="all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:rgba(235,87,87,.16);border:1px solid rgba(235,87,87,.3);font-size:12px">✕</button>
        </div>
      </div>
      <div id="cc-ov-board" style="display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr);width:min(88vmin,620px);height:min(88vmin,620px);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 60px rgba(0,0,0,.45)"></div>
      <div style="display:flex;justify-content:space-between;gap:16px;font-size:1em;opacity:.94;width:min(94vmin,620px)">
        <span id="cc-ov-best">--</span><span id="cc-ov-eval">--</span><span id="cc-ov-depth">--</span>
      </div>
    `;
    document.documentElement.appendChild(overlayRoot);
    overlayFlipped = false;
    renderOverlayBoard();
    overlayRoot.querySelector('#cc-ov-close').addEventListener('click', () => setOverlayVisible(false));
    overlayRoot.querySelector('#cc-ov-flip').addEventListener('click', () => { overlayFlipped = !overlayFlipped; renderOverlayBoard(); });
  }

  function setOverlayVisible(v) {
    if (!overlayRoot) createOverlay();
    overlayRoot.style.display = v ? 'flex' : 'none';
    const boardEl = getBoard();
    if (boardEl) boardEl.style.visibility = v ? 'hidden' : '';
  }

  function pieceCharToText(p) {
    const map = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    return map[p] || '';
  }

  const pieceImg = (p) => {
    const color = p === p.toUpperCase() ? 'w' : 'b';
    const type = p.toUpperCase();
    return `https://www.chess.com/bundles/web/images/pieces/neo/${color}${type}.png`;
  };

  const PIECE_FONT = '"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2","DejaVu Sans",sans-serif';

  function renderOverlayBoard() {
    if (!overlayRoot) return;
    const el = overlayRoot.querySelector('#cc-ov-board');
    if (!el) return;
    const board = getBoard();
    let grid = {};
    if (board) { try { grid = readGrid(board); } catch (e) {} }
    const files = overlayFlipped ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
    const ranks = overlayFlipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
    let html = '';
    for (const r of ranks) {
      for (const f of files) {
        const sq = `${f}${r}`;
        const p = grid[sq] || '';
        const dark = (f + r) % 2 === 0;
        let bg = dark ? '#4b5a6b' : '#d7dee6';
        if (lastBestMove && lastBestMove.length >= 4) {
          const from = squareCode(lastBestMove.slice(0, 2));
          const to = squareCode(lastBestMove.slice(2, 4));
          if (sq === from) { bg = 'rgba(235,87,87,.6)'; }
          if (sq === to) { bg = 'rgba(72,193,249,.55)'; }
        }
        html += `<div style="display:flex;align-items:center;justify-content:center;background:${bg};font-size:${Math.max(14, Math.min(44, Math.round(Math.min(88, 620) / 8 * 0.66)))}px;line-height:1">${p ? `<img src="${pieceImg(p)}" alt="${p}" style="width:82%;height:82%;object-fit:contain;pointer-events:none;user-select:none;-webkit-user-drag:none">` : ''}</div>`;
      }
    }
    el.innerHTML = html;
    const bestEl = overlayRoot.querySelector('#cc-ov-best');
    if (bestEl) {
      if (lastBestMove) {
        const b = getBoard();
        bestEl.textContent = (b && sanFor(b, lastBestMove)) || lastBestMove;
      } else bestEl.textContent = '--';
    }
    const evEl = overlayRoot.querySelector('#cc-ov-eval');
    if (evEl) evEl.textContent = lastScore ? formatScore(lastScore) : '--';
    const dEl = overlayRoot.querySelector('#cc-ov-depth');
    if (dEl) dEl.textContent = lastDepth ? `d${lastDepth}` : '--';
  }

  function createGui() {
    if (document.getElementById('cc-mini-gui')) return;
    const root = document.createElement('div');
    root.id = 'cc-mini-gui';
    root.style.cssText = [
      'position:fixed','top:16px','right:16px','z-index:2147483647',
      'width:238px','height:174px','min-width:184px','min-height:150px','max-width:520px','max-height:430px',
      'background:linear-gradient(160deg,rgba(24,26,32,.58),rgba(12,14,18,.52))','color:#eef2f8',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'border:1px solid rgba(255,255,255,.10)','border-radius:16px','padding:10px 12px 12px',
      'box-shadow:0 8px 24px rgba(0,0,0,.22), 0 1px 0 rgba(255,255,255,.05) inset',
      'backdrop-filter:blur(24px) saturate(150%)','-webkit-backdrop-filter:blur(24px) saturate(150%)',
      'user-select:none','box-sizing:border-box','overflow:hidden','display:flex','flex-direction:column','gap:8px'
    ].join(';');

    root.innerHTML = `
      <div id="cc-drag" style="cursor:move;font-weight:600;font-size:1em;letter-spacing:.2px;display:flex;justify-content:space-between;align-items:center;opacity:.95;flex:0 0 auto;padding:1px 2px">
        <span>Chesscheat</span><span style="font-weight:500;font-size:.9em;opacity:.8">G: <span id="cc-toggle">ON</span></span>
      </div>
      <div id="cc-controls" style="display:flex;gap:8px;align-items:stretch;flex:1 1 auto;min-height:0">
        <button id="cc-start" style="all:unset;cursor:pointer;flex:1 1 0;background:#2f7df6;padding:8px 10px;border-radius:10px;font-size:.95em;font-weight:600;letter-spacing:.2px;box-shadow:none;display:flex;align-items:center;justify-content:center;text-align:center;transition:filter .12s ease, transform .06s ease">Start</button>
        <label style="font-size:.9em;opacity:.9;display:flex;gap:6px;align-items:center;justify-content:center;flex:0 0 auto;padding:0 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px">Depth<input id="cc-depth" type="number" min="1" max="30" value="${globalDepth}" style="width:2.3em;background:transparent;color:#fff;border:none;border-bottom:1px dashed rgba(255,255,255,.25);border-radius:0;padding:2px 2px;font-size:1em;outline:none;text-align:center"></label>
      </div>
      <div id="cc-mp-row" style="display:flex;gap:8px;align-items:center;flex:0 0 auto;font-size:.84em;opacity:.9">
        <button id="cc-mp-prev" title="Previous move" style="all:unset;cursor:pointer;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10)">◀</button>
        <button id="cc-mp-next" title="Next move" style="all:unset;cursor:pointer;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10)">▶</button>
        <label style="display:flex;gap:6px;align-items:center;opacity:.9;cursor:pointer">MultiPV<select id="cc-multipv" style="background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:3px 6px;font-size:1em;outline:none">
          <option value="1"${multiPv === 1 ? ' selected' : ''}>1</option>
          <option value="2"${multiPv === 2 ? ' selected' : ''}>2</option>
          <option value="3"${multiPv === 3 ? ' selected' : ''}>3</option>
          <option value="4"${multiPv === 4 ? ' selected' : ''}>4</option>
          <option value="5"${multiPv === 5 ? ' selected' : ''}>5</option>
        </select></label>
      </div>
      <div id="cc-flash-row" style="display:flex;gap:8px;align-items:center;flex:0 0 auto;font-size:.84em;opacity:.9;flex-wrap:wrap">
        <button id="cc-flashkey" title="Click to set flash key" style="all:unset;cursor:pointer;flex:0 0 auto;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10)">Flash: <span id="cc-flashkey-label"></span></button>
        <button id="cc-best" title="Reset to best move" style="all:unset;cursor:pointer;flex:0 0 auto;padding:3px 8px;border-radius:7px;background:rgba(47,125,246,.14);border:1px solid rgba(47,125,246,.3)">Best</button>
        <button id="cc-overlay-btn" title="Toggle overlay (O)" style="all:unset;cursor:pointer;flex:0 0 auto;padding:3px 8px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)">Overlay</button>
        <label style="display:flex;gap:6px;align-items:center;opacity:.9;cursor:pointer"><input id="cc-hide" type="checkbox" ${hideUntilKey ? 'checked' : ''} style="accent-color:#4a90ff">Hide until key</label>
      </div>
      <label id="cc-hide-gui-wrap" style="display:${hideUntilKey ? 'flex' : 'none'};gap:6px;align-items:center;flex:0 0 auto;font-size:.8em;opacity:.82;cursor:pointer;padding-left:6px"><input id="cc-hide-gui" type="checkbox" ${flashWhenGuiHidden ? 'checked' : ''} style="accent-color:#4a90ff">Work when GUI hidden (G)</label>
      <div id="cc-status" style="font-size:.86em;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:5px 8px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.05);border-radius:8px;flex:0 0 auto">idle (G toggle)</div>
      <div id="cc-resize" title="Resize" style="position:absolute;right:5px;bottom:5px;width:16px;height:16px;cursor:nwse-resize;opacity:.6;display:flex;align-items:flex-end;justify-content:flex-end">
        <svg viewBox="0 0 12 12" width="16" height="16" aria-hidden="true"><path d="M11 3 L3 11" stroke="rgba(255,255,255,.4)" stroke-width="1.1" stroke-linecap="round"/><path d="M11 6 L6 11" stroke="rgba(255,255,255,.4)" stroke-width="1.1" stroke-linecap="round"/><path d="M11 9 L9 11" stroke="rgba(255,255,255,.4)" stroke-width="1.1" stroke-linecap="round"/></svg>
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
    const mpSelect = root.querySelector('#cc-multipv');
    const mpPrev = root.querySelector('#cc-mp-prev');
    const mpNext = root.querySelector('#cc-mp-next');
    const applyMultiPv = (n, rerun) => {
      multiPv = Math.min(5, Math.max(1, n));
      if (mpSelect) mpSelect.value = String(multiPv);
      multiPvIdx = 0;
      saveSettings();
      if (rerun && running && lastPosKey) requestBestMove(lastPosKey, lastPosKey);
      else updateStatusDisplay();
    };
    if (mpSelect) mpSelect.addEventListener('change', () => applyMultiPv(parseInt(mpSelect.value, 10), true));
    if (mpPrev) mpPrev.addEventListener('click', () => {
      if (multiPv <= 1) return;
      multiPvIdx = (multiPvIdx - 1 + multiPv) % multiPv;
      const mv = lastPvLines[multiPvIdx] && lastPvLines[multiPvIdx].move;
      lastBestMove = mv || lastBestMove;
      renderHighlights(lastBestMove);
      updateStatusDisplay();
    });
    const bestBtn = root.querySelector('#cc-best');
    const overlayBtn = root.querySelector('#cc-overlay-btn');
    if (overlayBtn) overlayBtn.addEventListener('click', () => setOverlayVisible(!overlayRoot || overlayRoot.style.display === 'none'));
    if (bestBtn) bestBtn.addEventListener('click', () => {
      if (!running) return;
      const board = getBoard();
      if (!board) return;
      const pos = readPosition(board);
      if (!pos || !pos.fen) return;
      lastPosInfo = pos;
      lastPosKey = '';
      checkPosition();
    });
    if (mpNext) mpNext.addEventListener('click', () => {
      if (multiPv <= 1) return;
      multiPvIdx = (multiPvIdx + 1) % multiPv;
      const mv = lastPvLines[multiPvIdx] && lastPvLines[multiPvIdx].move;
      lastBestMove = mv || lastBestMove;
      renderHighlights(lastBestMove);
      updateStatusDisplay();
    });

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
          startBtn.style.background = '#3a3f4b';
          startBtn.style.boxShadow = 'none';
        } else {
          startBtn.textContent = 'Start';
        }
      } else {
        stop();
        startBtn.textContent = 'Start';
        startBtn.style.background = '#2f7df6';
        startBtn.style.boxShadow = 'none';
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
      if (!dragging) return;
      root.style.left = `${Math.max(0, e.clientX - offX)}px`;
      root.style.top = `${Math.max(0, e.clientY - offY)}px`;
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    const resizeHandle = root.querySelector('#cc-resize');
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    const updateScale = () => {
      const rect = root.getBoundingClientRect();
      const scale = Math.min(rect.width / 238, rect.height / 174);
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
      root.style.height = `${Math.min(430, Math.max(150, startH + (e.clientY - startY)))}px`;
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
    if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setOverlayVisible(!overlayRoot || overlayRoot.style.display === 'none'); return; }
    if (e.key === flashKey) { e.preventDefault(); flashMove(); }
  }, true);

  function init() { createGui(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
