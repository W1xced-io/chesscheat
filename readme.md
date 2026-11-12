<h1>Chess Cheat</h1>
<p>Faster and more accurate than the original: quicker move detection, better engine analysis, a richer GUI, and bundled Stockfish.</p>
<p>Chess cheat utilizes the Stockfish engine and the power of your computer to show you the best move to make in any chess.com game. It guarantees you wins in at least 90% of games you play and can greatly help you improve your chess skills.

<i>Note: this project was developed for learning purposes, I do not condone or encourage cheating in games and this project should help you get better at chess. Non fair play might result in your chess.com account being suspended if you do not use wisely. </i>
<br>


![Preview](preview.gif)

<h2>What's improved vs the original</h2>
<ul>
  <li><b>Performance & analysis:</b> fast move detection (MutationObserver + debounce), one search at a time with <code>stop</code> before new positions, stale-result filtering, and engine worker cleanup on stop.</li>
  <li><b>Accurate positions:</b> reads the exact FEN from chess.com's board API when available (castling rights, en passant, side to move) with a DOM fallback that infers castling/en passant and tracks the mover.</li>
  <li><b>Bundled engine:</b> ships Stockfish 19 lite (single-threaded WASM) in <code>engine/</code>, loaded via a bridge/blob worker with fallback to chess.com's engine - no dependency on site engine path/hash changes.</li>
  <li><b>Correct side to move:</b> detects which color you play to avoid showing the opponent's best move as yours.</li>
  <li><b>Richer GUI/status:</b> draggable, resizable glassy panel with scalable controls; shows search depth, evaluation (cp/mate), and best move in SAN.</li>
  <li><b>MultiPV analysis:</b> analyze up to 5 lines at once (<b>MultiPV 1-5</b>) and cycle through them with <b>&#9664;</b> / <b>&#9654;</b>.</li>
  <li><b>One-click best move:</b> the <b>Best</b> button instantly restarts analysis from the current position and jumps to the top move.</li>
  <li><b>Flash & stealth controls:</b> configurable flash key (default <code>`</code>) to briefly reveal the move, <b>Hide until key</b> mode, and an option to allow flashing while the GUI is hidden with <code>G</code>.</li>
  <li><b>Persistence & cleanup:</b> depth/MultiPV/flash/hide settings saved in <code>localStorage</code>; unused legacy files removed and manifest/architecture cleaned up (main-world script + bridge for bundled engine access).</li>
  <li><b>Separate desktop overlay:</b> an always-on-top Electron window (in <code>desktop/</code>) shows the board, pieces, best move and evaluation independently of the browser. It auto-flips to your color, supports manual flip, and renders real piece images.</li>
</ul>

<h1>Desktop overlay (Electron)</h1>
<p>A standalone always-on-top window that mirrors the board and analysis outside the browser.</p>
<ul>
  <li><b>Setup:</b> <code>cd desktop &amp;&amp; npm install &amp;&amp; npm start</code></li>
  <li><b>Auto-flip:</b> the board orients to your playing color (black at the bottom when you play black); the <b>Flip</b> button overrides it.</li>
  <li><b>Piece images:</b> renders real chess piece SVGs (lichess cburnett set).</li>
  <li><b>Data flow:</b> the extension posts live state to a local bridge on <code>http://127.0.0.1:43117/state</code>.</li>
  <li><b>Stealth:</b> the move highlight only appears on your turn.</li>
</ul>

<h1>Usage</h1>
<ul>
  <li>A draggable, resizable GUI appears on chess.com pages.</li>
  <li>Click <b>Start</b> to run analysis, <b>Stop</b> to stop.</li>
  <li>Press <b>G</b> to toggle the GUI and hints/highlights on/off. While typing in inputs, <b>G</b> won't toggle.</li>
  <li>Adjust <b>Depth</b> in the panel (saved automatically).</li>
  <li><b>MultiPV:</b> pick how many lines to analyze (1-5); use <b>&#9664;</b> / <b>&#9654;</b> to cycle and show each line's move.</li>
  <li><b>Best:</b> click to restart analysis on the current position and reset to the top move.</li>
  <li><b>Flash:</b> click <b>Flash</b> to set a key, press it to show the move briefly (~700 ms). Enable <b>Hide until key</b> to keep hints hidden until flashed; optionally enable flashing while the GUI is hidden with <code>G</code>.</li>
  <li>Drag the panel by its header and resize from the bottom-right corner.</li>
</ul>

<h1>How to install (Firefox):</h1>
1. Open Firefox and go to <code>about:debugging#/runtime/this-firefox</code>.<br>
2. Click <b>Load Temporary Add-on...</b><br>
3. Select <code>manifest.json</code> from this folder.

<h1>How to install (Chrome):</h1>
Open <code>chrome://extensions</code>, enable Developer mode, click <b>Load unpacked</b>, and select this folder.

<h1>How to install (Microsoft Edge):</h1>
Open <code>edge://extensions</code>, enable Developer mode, click <b>Load unpacked</b>, and select this folder.

<h1>How to install (Safari, macOS):</h1>
1. Requires macOS with Safari 15.4+ and Xcode Command Line Tools.<br>
2. Convert the extension: <code>xcrun safari-web-extension-converter /path/to/this/folder</code><br>
3. Open the generated Xcode project, build and run.<br>
4. In Safari: Settings → Extensions, enable the extension and allow it for chess.com.