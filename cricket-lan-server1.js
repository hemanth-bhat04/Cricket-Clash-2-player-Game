#!/usr/bin/env node
/**
 * Cricket Clash — LAN Multiplayer Server
 * Pure Node.js, zero dependencies.
 * Run: node cricket-lan-server.js
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = 3000;

// ─── Local IP ─────────────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const LOCAL_IP = getLocalIP();

// ─── Game constants ────────────────────────────────────────────────────────────
const SHOTS = [
  { name: 'Defensive', emoji: '🛡️', runs: 1 },
  { name: 'Drive',     emoji: '🏏', runs: 2 },
  { name: 'Cut',       emoji: '⚡', runs: 3 },
  { name: 'Sweep',     emoji: '🌊', runs: 4 },
  { name: 'Lofted',   emoji: '🌙', runs: 5 },
  { name: 'Six!',      emoji: '💥', runs: 6 },
];
const MAX_WICKETS = 10;
const MAX_BALLS   = 30; // 5 overs

// ─── Game state ────────────────────────────────────────────────────────────────
function newGame() {
  return {
    slots: [null, null],
    names: ['Player 1', 'Player 2'],
    innings: 1,
    batting: 0,
    scores:  [0, 0],
    wickets: [0, 0],
    balls:   0,
    target:  null,
    picks:   [null, null],
    phase:   'waiting',
    lastResult: null,
  };
}
let game = newGame();

function bowlerIdx() { return game.batting === 0 ? 1 : 0; }

// ─── WebSocket clients ─────────────────────────────────────────────────────────
const clients = new Map(); // id -> { send(text), socket }

function sendTo(id, obj) {
  const c = clients.get(id);
  if (c) try { c.send(JSON.stringify(obj)); } catch(_) {}
}

function broadcastState() {
  for (const [sid] of clients) {
    const slot = game.slots.indexOf(sid);
    sendTo(sid, {
      type: 'state',
      slot,
      game: {
        phase:      game.phase,
        innings:    game.innings,
        batting:    game.batting,
        scores:     game.scores,
        wickets:    game.wickets,
        balls:      game.balls,
        target:     game.target,
        names:      game.names,
        lastResult: game.lastResult,
        myPick:     slot >= 0 ? game.picks[slot] !== null : false,
        slots:      game.slots.map(s => s !== null),
      }
    });
  }
}

// ─── Game logic ────────────────────────────────────────────────────────────────
function onMessage(sid, msg) {
  const slot = game.slots.indexOf(sid);

  if (msg.type === 'setName' && slot >= 0) {
    game.names[slot] = String(msg.name || '').slice(0, 20) || game.names[slot];
    broadcastState();
    return;
  }

  if (msg.type === 'pick' && slot >= 0 && game.phase === 'picking') {
    const idx = Number(msg.pick);
    if (isNaN(idx) || idx < 0 || idx > 5) return;
    if (game.picks[slot] !== null) return;
    game.picks[slot] = idx;

    if (game.picks[game.batting] !== null && game.picks[bowlerIdx()] !== null) {
      resolveBall();
    } else {
      broadcastState();
    }
    return;
  }

  if (msg.type === 'nextBall' && game.phase === 'result') {
    advanceGame();
    return;
  }

  if (msg.type === 'restart') {
    const s0 = game.slots[0], s1 = game.slots[1];
    const n0 = game.names[0],  n1 = game.names[1];
    game = newGame();
    game.slots = [s0, s1];
    game.names = [n0, n1];
    if (s0 && s1) game.phase = 'picking';
    broadcastState();
    return;
  }
}

function resolveBall() {
  const bSlot = game.batting;
  const wSlot = bowlerIdx();
  const bPick = game.picks[bSlot];
  const wPick = game.picks[wSlot];

  game.balls++;
  const isWicket = (bPick === wPick);

  if (isWicket) {
    game.wickets[bSlot]++;
    game.lastResult = { type: 'wicket', batPick: bPick, bowlPick: wPick };
  } else {
    const runs = SHOTS[bPick].runs;
    game.scores[bSlot] += runs;
    game.lastResult = { type: 'runs', runs, batPick: bPick, bowlPick: wPick };
  }

  if (game.target !== null && game.scores[bSlot] > game.target) {
    game.phase = 'gameover';
    broadcastState();
    return;
  }

  game.phase = 'result';
  broadcastState();
}

function advanceGame() {
  const bSlot = game.batting;
  const done  = game.balls >= MAX_BALLS || game.wickets[bSlot] >= MAX_WICKETS;

  if (done) {
    if (game.innings === 1) {
      game.target  = game.scores[bSlot];
      game.innings = 2;
      game.batting = bSlot === 0 ? 1 : 0;
      game.balls   = 0;
      game.picks   = [null, null];
      game.phase   = 'picking';
      game.lastResult = null;
    } else {
      game.phase = 'gameover';
    }
  } else {
    game.picks      = [null, null];
    game.phase      = 'picking';
    game.lastResult = null;
  }
  broadcastState();
}

// ─── WebSocket (pure Node built-ins) ─────────────────────────────────────────
function wsHandshake(req, socket) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
}

function wsEncode(text) {
  const payload = Buffer.from(text, 'utf8');
  const len     = payload.length;
  let   header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Incrementally parse WebSocket frames from a growing buffer
function parseFrames(buf) {
  const frames = [];
  let   offset = 0;

  while (true) {
    if (buf.length - offset < 2) break;

    const b0     = buf[offset];
    const b1     = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);

    let payloadLen = b1 & 0x7f;
    let hdrEnd     = offset + 2;

    if (payloadLen === 126) {
      if (buf.length - offset < 4) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      hdrEnd     = offset + 4;
    } else if (payloadLen === 127) {
      if (buf.length - offset < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      hdrEnd     = offset + 10;
    }

    const maskStart    = masked ? hdrEnd : null;
    const payloadStart = hdrEnd + (masked ? 4 : 0);
    const frameEnd     = payloadStart + payloadLen;

    if (buf.length < frameEnd) break; // need more bytes

    let data = buf.slice(payloadStart, frameEnd);
    if (masked) {
      const mask = buf.slice(maskStart, maskStart + 4);
      const out  = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) out[i] = data[i] ^ mask[i % 4];
      data = out;
    }

    frames.push({ opcode, data });
    offset = frameEnd;
  }

  return { frames, remaining: buf.slice(offset) };
}

function handleWsConnection(req, socket) {
  wsHandshake(req, socket);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 20000);

  const id = crypto.randomUUID();
  let   buf = Buffer.alloc(0);

  const client = {
    send(text) { try { socket.write(wsEncode(text)); } catch(_) {} },
    socket,
  };
  clients.set(id, client);

  // Assign player slot
  let slot = -1;
  if      (game.slots[0] === null) { game.slots[0] = id; slot = 0; }
  else if (game.slots[1] === null) { game.slots[1] = id; slot = 1; }

  if (game.slots[0] && game.slots[1] && game.phase === 'waiting') {
    game.phase = 'picking';
  }

  sendTo(id, { type: 'joined', slot });
  broadcastState();

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, remaining } = parseFrames(buf);
    buf = remaining;

    for (const frame of frames) {
      if (frame.opcode === 8) { socket.destroy(); return; }   // close
      if (frame.opcode === 9) {                                // ping → pong
        const pong = Buffer.from([0x8a, 0x00]);
        try { socket.write(pong); } catch(_) {}
      }
      if (frame.opcode === 1 || frame.opcode === 2) {         // text/binary
        try { onMessage(id, JSON.parse(frame.data.toString('utf8'))); } catch(_) {}
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('end',   cleanup);
  socket.on('error', () => { try { socket.destroy(); } catch(_) {} });

  function cleanup() {
    clients.delete(id);
    if (game.slots[0] === id) game.slots[0] = null;
    if (game.slots[1] === id) game.slots[1] = null;
    if (game.phase !== 'waiting' && game.phase !== 'gameover') {
      game.phase = 'waiting';
    }
    broadcastState();
  }
}

// ─── HTML client ──────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Cricket Clash ⚡</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--gold:#f0c040;--grass:#1a4a1a;--cream:#fdf6e3;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--grass);font-family:'Rajdhani',sans-serif;min-height:100vh;
  background-image:repeating-linear-gradient(0deg,transparent,transparent 60px,rgba(255,255,255,.025) 60px,rgba(255,255,255,.025) 61px),
  repeating-linear-gradient(90deg,transparent,transparent 60px,rgba(255,255,255,.025) 60px,rgba(255,255,255,.025) 61px);}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(255,220,100,.1) 0%,transparent 55%);pointer-events:none;}
h1{font-family:'Playfair Display',serif;font-size:clamp(1.8rem,5vw,3rem);font-weight:900;color:var(--gold);
  text-align:center;letter-spacing:2px;text-shadow:0 0 30px rgba(240,192,64,.6),2px 3px 0 rgba(0,0,0,.5);padding:16px 0 2px;}
.sub{text-align:center;color:rgba(255,255,255,.4);font-size:.75rem;letter-spacing:4px;text-transform:uppercase;margin-bottom:18px;}

/* LOBBY */
#lobby{display:flex;flex-direction:column;align-items:center;gap:14px;padding:20px;}
.qr-box{background:#fff;border-radius:14px;padding:14px;box-shadow:0 8px 40px rgba(0,0,0,.5);}
.url-pill{background:rgba(0,0,0,.4);border:1.5px solid rgba(240,192,64,.4);border-radius:10px;
  padding:10px 18px;color:var(--gold);font-size:.9rem;letter-spacing:1px;font-weight:700;text-align:center;
  word-break:break-all;max-width:360px;}
.hint{color:rgba(255,255,255,.48);font-size:.8rem;letter-spacing:1px;text-align:center;}
input.ni{background:rgba(0,0,0,.35);border:1.5px solid rgba(240,192,64,.4);border-radius:8px;
  padding:10px 16px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:1rem;letter-spacing:1px;
  text-align:center;width:240px;outline:none;}
input.ni:focus{border-color:var(--gold);}
.gbtn{background:linear-gradient(135deg,var(--gold),#d4a020);color:#1a0a00;border:none;
  padding:12px 32px;font-size:1rem;font-family:'Rajdhani',sans-serif;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;border-radius:50px;cursor:pointer;
  box-shadow:0 6px 24px rgba(240,192,64,.35);transition:all .2s;}
.gbtn:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(240,192,64,.5);}
.gbtn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
#lst{color:rgba(255,255,255,.5);font-size:.8rem;letter-spacing:1px;min-height:20px;text-align:center;}

/* CONN BAR */
.cbar{text-align:center;font-size:.62rem;letter-spacing:2px;color:rgba(255,255,255,.32);padding:6px;}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#e74c3c;margin-right:5px;vertical-align:middle;transition:.4s;}
.dot.on{background:#2ecc71;box-shadow:0 0 7px #2ecc71;}

/* GAME */
#game{display:none;}
.scoreboard{display:flex;justify-content:center;align-items:stretch;max-width:700px;margin:0 auto 14px;
  border:2px solid var(--gold);border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.5);}
.pp{flex:1;padding:14px 12px;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;transition:filter .3s;}
.pp.p0{background:linear-gradient(135deg,#0d2d45,#1a4f6e);}
.pp.p1b{background:linear-gradient(135deg,#3d1200,#6e2a10);}
.pp.bat{filter:brightness(1.2);}
.pp.bat::after{content:'🏏 BATTING';position:absolute;bottom:5px;font-size:.54rem;letter-spacing:2px;color:var(--gold);font-weight:700;}
.pp.you::before{content:'YOU ▶';position:absolute;top:5px;right:7px;font-size:.5rem;letter-spacing:1px;color:rgba(255,255,255,.42);}
.pname{font-family:'Playfair Display',serif;font-size:.9rem;font-weight:700;color:var(--cream);}
.pscore{font-size:clamp(2rem,7vw,3.5rem);font-weight:700;line-height:1;color:#fff;font-family:'Playfair Display',serif;}
.wrow{display:flex;gap:3px;flex-wrap:wrap;justify-content:center;margin-top:2px;}
.wd{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);transition:.3s;}
.wd.out{background:#e74c3c;border-color:#c0392b;box-shadow:0 0 5px #e74c3c;}
.midp{width:78px;background:linear-gradient(180deg,#080808,#181818);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:5px;border-left:1px solid rgba(240,192,64,.3);border-right:1px solid rgba(240,192,64,.3);}
.vst{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:900;color:var(--gold);text-shadow:0 0 14px var(--gold);}
.il{font-size:.5rem;letter-spacing:1.5px;color:rgba(255,255,255,.32);text-transform:uppercase;}
.iv{font-size:.95rem;color:#fff;font-weight:700;}

.tb{text-align:center;font-size:.82rem;color:var(--gold);letter-spacing:3px;text-transform:uppercase;
  margin:0 auto 10px;max-width:700px;font-weight:700;padding:0 12px;}

/* PITCH */
.pw{display:flex;justify-content:center;margin-bottom:14px;}
.pitch{background:linear-gradient(160deg,#d4a843,#b8922e,#c9a540);width:min(290px,90vw);border-radius:12px;
  padding:18px 16px;box-shadow:0 6px 30px rgba(0,0,0,.6);border:2px solid rgba(200,168,80,.4);position:relative;overflow:hidden;}
.pitch::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:2px;height:100%;background:rgba(255,255,255,.18);}
.crease{width:70%;height:2px;background:rgba(255,255,255,.45);margin:0 auto 12px;border-radius:2px;}
.crease.b{margin:12px auto 0;}
.sr{display:flex;justify-content:center;gap:5px;margin:3px 0;}
.st{width:4px;height:22px;background:linear-gradient(180deg,#fff,#ddd);border-radius:2px;box-shadow:0 2px 5px rgba(0,0,0,.4);transition:all .35s;}
.st.k{background:#e74c3c;transform:rotate(22deg) translateY(5px);}
.ball{width:30px;height:30px;background:radial-gradient(circle at 35% 35%,#e74c3c,#922b21);
  border-radius:50%;margin:10px auto;box-shadow:0 4px 12px rgba(0,0,0,.5);position:relative;}
.ball::after{content:'';position:absolute;top:4px;left:3px;right:3px;height:22px;border:1.5px solid rgba(200,200,200,.25);border-radius:50%;}
.ball.fly{animation:ballFly .5s ease-out;}
@keyframes ballFly{0%{transform:scale(1) translateY(0)}40%{transform:scale(.65) translateY(-26px)}70%{transform:scale(1.25) translateY(4px)}100%{transform:scale(1) translateY(0)}}

.sbar{text-align:center;margin:0 0 10px;min-height:34px;}
.smsg{display:inline-block;padding:6px 16px;border-radius:20px;font-size:.78rem;letter-spacing:2px;text-transform:uppercase;font-weight:700;}
.smsg.wait{background:rgba(240,192,64,.12);color:var(--gold);border:1px solid rgba(240,192,64,.3);}
.smsg.lock{background:rgba(46,204,113,.12);color:#2ecc71;border:1px solid rgba(46,204,113,.3);}
.smsg.wkt{background:rgba(231,76,60,.2);color:#e74c3c;border:1px solid rgba(231,76,60,.3);}
.smsg.run{background:rgba(46,204,113,.12);color:#2ecc71;border:1px solid rgba(46,204,113,.3);}

.csec{max-width:700px;margin:0 auto 14px;padding:0 10px;}
.ctitle{text-align:center;font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.38);margin-bottom:9px;}
.cgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.card{background:linear-gradient(145deg,#1a2a1a,#0d1a0d);border:1.5px solid rgba(240,192,64,.3);
  border-radius:10px;padding:12px 6px;text-align:center;cursor:pointer;
  transition:all .22s cubic-bezier(.34,1.56,.64,1);position:relative;user-select:none;}
.card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(240,192,64,.1),transparent);opacity:0;transition:.2s;border-radius:9px;}
.card:hover:not(.off):not(.sel)::before{opacity:1;}
.card:hover:not(.off):not(.sel){border-color:var(--gold);transform:translateY(-4px) scale(1.04);box-shadow:0 8px 20px rgba(0,0,0,.45),0 0 14px rgba(240,192,64,.18);}
.card.sel{border-color:#fff;background:linear-gradient(145deg,#243a24,#132213);box-shadow:0 0 16px rgba(255,255,255,.1);transform:translateY(-2px);}
.card.off{opacity:.3;cursor:not-allowed;}
.card.hit{border-color:#e74c3c!important;background:linear-gradient(145deg,#3a0808,#200202)!important;opacity:1!important;}
.card.scored{border-color:#2ecc71!important;background:linear-gradient(145deg,#0a2a0a,#052205)!important;opacity:1!important;}
.ce{font-size:1.5rem;display:block;margin-bottom:3px;}
.cr{font-size:1.25rem;font-weight:700;color:var(--gold);font-family:'Playfair Display',serif;line-height:1;}
.cn{font-size:.55rem;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.45);margin-top:2px;display:block;}

.logsec{max-width:700px;margin:0 auto 30px;padding:0 10px;}
.logt{font-size:.6rem;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.28);margin-bottom:6px;text-align:center;}
.logbox{background:rgba(0,0,0,.28);border-radius:10px;border:1px solid rgba(255,255,255,.06);padding:8px;max-height:90px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;}
.le{font-size:.72rem;color:rgba(255,255,255,.52);padding:2px 5px;border-radius:3px;animation:fs .3s ease;}
.le.r6{color:#f0c040;font-weight:700;background:rgba(240,192,64,.08);}
.le.r4{color:#5dade2;font-weight:700;}
.le.wk{color:#e74c3c;font-weight:700;background:rgba(231,76,60,.08);}
@keyframes fs{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:translateX(0)}}

.ov{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:100;
  background:rgba(0,0,0,.65);backdrop-filter:blur(7px);opacity:0;pointer-events:none;transition:opacity .3s;}
.ov.show{opacity:1;pointer-events:all;}
.ovc{background:linear-gradient(145deg,#0a1a0a,#1a2a10);border:2px solid var(--gold);border-radius:20px;
  padding:30px 40px;text-align:center;transform:scale(.8);transition:transform .4s cubic-bezier(.34,1.56,.64,1);
  box-shadow:0 20px 60px rgba(0,0,0,.8);max-width:88vw;}
.ov.show .ovc{transform:scale(1);}
.oe{font-size:3rem;display:block;margin-bottom:8px;}
.ot{font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:900;color:var(--gold);text-shadow:0 0 20px var(--gold);margin-bottom:6px;}
.od{color:rgba(255,255,255,.65);font-size:.9rem;letter-spacing:2px;margin-bottom:18px;}
</style>
</head>
<body>

<h1>🏏 Cricket Clash</h1>
<p class="sub">LAN Multiplayer</p>

<div id="lobby">
  <div class="qr-box"><canvas id="qr" width="180" height="180"></canvas></div>
  <div class="url-pill" id="urlPill">Connecting…</div>
  <p class="hint">Share this URL with Player 2 (same WiFi)</p>
  <input class="ni" id="nameIn" placeholder="Enter your name" maxlength="20">
  <button class="gbtn" id="joinBtn" onclick="joinGame()">Join Game →</button>
  <div id="lst"></div>
</div>

<div id="game">
  <div class="cbar"><span class="dot on" id="cdot"></span><span id="clbl">Connected</span></div>

  <div class="scoreboard">
    <div class="pp p0" id="pp0">
      <div class="pname" id="pn0">P1</div>
      <div class="pscore" id="ps0">0</div>
      <div style="font-size:.55rem;color:rgba(255,255,255,.38);letter-spacing:1px;">RUNS</div>
      <div class="wrow" id="pw0"></div>
    </div>
    <div class="midp">
      <div class="vst">VS</div>
      <div class="il">INN</div><div class="iv" id="gInn">1</div>
      <div class="il">OVERS</div><div class="iv" id="gOv">0.0</div>
    </div>
    <div class="pp p1b" id="pp1">
      <div class="pname" id="pn1">P2</div>
      <div class="pscore" id="ps1">0</div>
      <div style="font-size:.55rem;color:rgba(255,255,255,.38);letter-spacing:1px;">RUNS</div>
      <div class="wrow" id="pw1"></div>
    </div>
  </div>

  <div class="tb" id="tb" style="display:none"></div>

  <div class="pw">
    <div class="pitch">
      <div class="crease"></div>
      <div class="sr"><div class="st" id="t0"></div><div class="st" id="t1"></div><div class="st" id="t2"></div></div>
      <div class="ball" id="bl"></div>
      <div class="sr"><div class="st" id="b0"></div><div class="st" id="b1"></div><div class="st" id="b2"></div></div>
      <div class="crease b"></div>
    </div>
  </div>

  <div class="sbar"><span class="smsg wait" id="sm">Waiting…</span></div>
  <div class="csec"><div class="ctitle" id="ct"></div><div class="cgrid" id="cg"></div></div>
  <div class="logsec"><div class="logt">Ball by Ball</div><div class="logbox" id="lb"></div></div>
</div>

<!-- Innings change -->
<div class="ov" id="innOv">
  <div class="ovc">
    <span class="oe">🔄</span>
    <div class="ot" id="innT">Innings Change!</div>
    <div class="od" id="innD"></div>
    <button class="gbtn" onclick="document.getElementById('innOv').classList.remove('show')">Start Innings 2 →</button>
  </div>
</div>

<!-- Game over -->
<div class="ov" id="goOv">
  <div class="ovc">
    <span class="oe" id="goE">🏆</span>
    <div class="ot" id="goT">Winner!</div>
    <div class="od" id="goD"></div>
    <button class="gbtn" onclick="sendMsg({type:'restart'})">Play Again</button>
  </div>
</div>

<script>
const SHOTS=[{n:'Defensive',e:'🛡️',r:1},{n:'Drive',e:'🏏',r:2},{n:'Cut',e:'⚡',r:3},
             {n:'Sweep',e:'🌊',r:4},{n:'Lofted',e:'🌙',r:5},{n:'Six!',e:'💥',r:6}];
const DELIV=[{n:'Yorker',e:'🎯'},{n:'Bouncer',e:'⚡'},{n:'Spinner',e:'🌀'},
             {n:'Swinger',e:'💨'},{n:'Full',e:'📍'},{n:'Slower',e:'🌙'}];

let ws, mySlot=-1, joined=false, picked=null, lastInn=1;

function drawQR(url) {
  const canvas=document.getElementById('qr'),ctx=canvas.getContext('2d'),S=180;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,S,S);
  function finder(x,y){ctx.fillStyle='#000';ctx.fillRect(x,y,42,42);ctx.fillStyle='#fff';ctx.fillRect(x+6,y+6,30,30);ctx.fillStyle='#000';ctx.fillRect(x+12,y+12,18,18);}
  finder(8,8);finder(130,8);finder(8,130);
  let h=url.split('').reduce((a,c)=>(a*31+c.charCodeAt(0))&0xffffffff,0);
  const rng=()=>{h=(h*1664525+1013904223)&0xffffffff;return(h>>>0)%2;};
  ctx.fillStyle='#000';
  for(let r=0;r<12;r++)for(let c=0;c<12;c++){if((r<4&&c<4)||(r<4&&c>8)||(r>8&&c<4))continue;if(rng())ctx.fillRect(8+c*13,8+r*13,11,11);}
  ctx.fillStyle='rgba(255,255,255,.9)';ctx.fillRect(40,74,100,32);
  ctx.fillStyle='#1a4a1a';ctx.font='bold 8px monospace';ctx.textAlign='center';
  ctx.fillText('Type URL below',90,87);ctx.fillText('on 2nd device',90,100);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    document.getElementById('cdot').classList.add('on');
    document.getElementById('clbl').textContent = 'Connected';
    document.getElementById('urlPill').textContent = location.href;
    drawQR(location.href);
  };
  ws.onmessage = e => { try{handle(JSON.parse(e.data));}catch(_){} };
  ws.onclose = () => {
    document.getElementById('cdot').classList.remove('on');
    document.getElementById('clbl').textContent = 'Reconnecting…';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

function sendMsg(obj){if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj));}

function joinGame(){
  const name=document.getElementById('nameIn').value.trim()||(mySlot>=0?'Player '+(mySlot+1):'Player');
  sendMsg({type:'setName',name});
  joined=true;
  document.getElementById('lobby').style.display='none';
  document.getElementById('game').style.display='block';
}

function handle(msg){
  if(msg.type==='joined'){
    mySlot=msg.slot;
    document.getElementById('lst').textContent=
      mySlot===0?'You are Player 1 — waiting for Player 2…':
      mySlot===1?'You are Player 2 — ready!':'Spectating (game full)';
    if(mySlot===-1)document.getElementById('joinBtn').disabled=true;
    return;
  }
  if(msg.type==='state') renderGame(msg);
}

function renderGame(msg){
  const g=msg.game;
  if(!g) return;

  // Update lobby status even while in lobby
  if(!joined){
    if(!g.slots[1]) document.getElementById('lst').textContent='Waiting for Player 2 to join…';
    return;
  }

  for(let p=0;p<2;p++){
    document.getElementById('pn'+p).textContent=g.names[p];
    document.getElementById('ps'+p).textContent=g.scores[p];
    renderDots(p,g.wickets[p]);
    document.getElementById('pp'+p).classList.toggle('bat',g.batting===p);
    document.getElementById('pp'+p).classList.toggle('you',mySlot===p);
  }
  document.getElementById('gInn').textContent=g.innings;
  document.getElementById('gOv').textContent=Math.floor(g.balls/6)+'.'+g.balls%6;

  // Innings change popup
  if(g.innings===2&&lastInn===1&&g.phase==='picking'){
    document.getElementById('innT').textContent='Innings Change!';
    document.getElementById('innD').textContent=g.names[g.batting]+' needs '+(g.target+1)+' to win';
    document.getElementById('innOv').classList.add('show');
  }
  lastInn=g.innings;

  // Target
  if(g.target!==null){
    const need=g.target-g.scores[g.batting]+1;
    document.getElementById('tb').style.display='block';
    document.getElementById('tb').textContent='Target: '+(g.target+1)+' | Need '+Math.max(0,need)+' from '+(30-g.balls)+' balls';
  } else document.getElementById('tb').style.display='none';

  // Game over
  if(g.phase==='gameover'){
    const [s0,s1]=g.scores;
    let em,ti,de;
    if(s0>s1){em='🏆';ti=g.names[0]+' Wins!';de='by '+(s0-s1)+' runs';}
    else if(s1>s0){em='🏆';ti=g.names[1]+' Wins!';de='by '+(s1-s0)+' runs';}
    else{em='🤝';ti="It's a Tie!";de='Both scored '+s0+' runs';}
    document.getElementById('goE').textContent=em;
    document.getElementById('goT').textContent=ti;
    document.getElementById('goD').textContent=de;
    document.getElementById('goOv').classList.add('show');
    return;
  }
  document.getElementById('goOv').classList.remove('show');

  // Result
  if(g.phase==='result'&&g.lastResult){
    const lr=g.lastResult;
    const bl=document.getElementById('bl');
    bl.classList.remove('fly');void bl.offsetWidth;bl.classList.add('fly');
    if(lr.type==='wicket'){
      flashStumps(g.batting);
      setSt('💀 WICKET! OUT!','wkt');
      addLog('💀 WICKET! '+SHOTS[lr.batPick].n+' vs '+DELIV[lr.bowlPick].n,'wk');
    } else {
      setSt((lr.runs===6?'💥':lr.runs===4?'🌊':'✅')+' '+lr.runs+' run'+(lr.runs>1?'s':'')+'!','run');
      addLog(SHOTS[lr.batPick].n+' vs '+DELIV[lr.bowlPick].n+' → '+lr.runs+' run'+(lr.runs>1?'s':''),
             lr.runs===6?'r6':lr.runs===4?'r4':'');
    }
    showResultCards(lr);
    picked=null;
    return;
  }

  // Picking
  picked=null;
  const amBat=mySlot===g.batting;
  const amBowl=mySlot>=0&&mySlot!==g.batting;

  if(g.phase==='waiting'||!g.slots[0]||!g.slots[1]){
    setSt('⏳ Waiting for both players…','wait');
    document.getElementById('ct').textContent='';
    document.getElementById('cg').innerHTML='';
    return;
  }

  if(g.myPick){
    setSt('✅ Locked in — waiting for opponent…','lock');
    showCards(amBat?SHOTS:DELIV,true);
    document.getElementById('ct').textContent=amBat?'🏏 Shot locked!':'🎳 Delivery locked!';
    return;
  }

  if(amBat){
    setSt('🏏 Pick your shot!','wait');
    document.getElementById('ct').textContent='🏏 Batting — choose your shot';
    showCards(SHOTS,false);
  } else if(amBowl){
    setSt('🎳 Pick your delivery!','wait');
    document.getElementById('ct').textContent='🎳 Bowling — choose your delivery';
    showCards(DELIV,false);
  } else {
    setSt('👀 Spectating','wait');
    document.getElementById('ct').textContent='';
    document.getElementById('cg').innerHTML='';
  }
}

function showCards(arr,locked){
  const grid=document.getElementById('cg');grid.innerHTML='';
  arr.forEach((item,i)=>{
    const c=document.createElement('div');
    c.className='card'+(locked?' off':'');
    c.innerHTML='<span class="ce">'+item.e+'</span><div class="cr">'+(item.r!==undefined?item.r:'')+'</div><span class="cn">'+item.n+'</span>';
    if(!locked){c.onclick=()=>{
      if(picked!==null)return;
      picked=i;
      grid.querySelectorAll('.card').forEach((cc,j)=>{cc.classList.toggle('sel',j===i);cc.classList.add('off');});
      sendMsg({type:'pick',pick:i});
    };}
    grid.appendChild(c);
  });
}

function showResultCards(lr){
  const grid=document.getElementById('cg');grid.innerHTML='';
  SHOTS.forEach((s,i)=>{
    const c=document.createElement('div');
    const h=i===lr.batPick&&lr.type==='wicket';
    const sc=i===lr.batPick&&lr.type==='runs';
    c.className='card off'+(h?' hit':sc?' scored':'');
    c.innerHTML='<span class="ce">'+s.e+'</span><div class="cr">'+s.r+'</div><span class="cn">'+s.n+'</span>';
    grid.appendChild(c);
  });
  const wrap=document.createElement('div');
  wrap.style.cssText='grid-column:1/-1;display:flex;justify-content:center;margin-top:4px;';
  const btn=document.createElement('button');
  btn.className='gbtn';btn.style.cssText='padding:10px 24px;font-size:.85rem;';
  btn.textContent='▶ Next Ball';
  btn.onclick=()=>{btn.disabled=true;sendMsg({type:'nextBall'});};
  wrap.appendChild(btn);grid.appendChild(wrap);
  document.getElementById('ct').textContent='';
}

function renderDots(p,count){
  const el=document.getElementById('pw'+p);el.innerHTML='';
  for(let i=0;i<10;i++){const d=document.createElement('div');d.className='wd'+(i<count?' out':'');el.appendChild(d);}
}
function flashStumps(batting){
  const ids=batting===0?['b0','b1','b2']:['t0','t1','t2'];
  ids.forEach(id=>document.getElementById(id).classList.add('k'));
  setTimeout(()=>ids.forEach(id=>document.getElementById(id).classList.remove('k')),1300);
}
function setSt(txt,cls){const el=document.getElementById('sm');el.textContent=txt;el.className='smsg '+cls;}
function addLog(txt,cls){
  const lb=document.getElementById('lb');
  const e=document.createElement('div');e.className='le '+cls;e.textContent=txt;
  lb.prepend(e);while(lb.children.length>20)lb.removeChild(lb.lastChild);
}

connect();
</script>
</body>
</html>`;

// ─── HTTP + WS server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.on('upgrade', (req, socket, head) => {
  if ((req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  handleWsConnection(req, socket);
});

server.listen(PORT, '0.0.0.0', () => {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    🏏  Cricket Clash — LAN Server        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  ' + pad('Local:   http://localhost:' + PORT, 40) + '║');
  console.log('║  ' + pad('Network: http://' + LOCAL_IP + ':' + PORT, 40) + '║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  1. Open Network URL on BOTH devices     ║');
  console.log('║  2. Enter names and tap Join Game        ║');
  console.log('║  3. Play!   Ctrl+C to stop               ║');
  console.log('╚══════════════════════════════════════════╝\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n❌  Port ' + PORT + ' is busy. Close other programs using it and retry.\n');
  } else console.error('Server error:', err);
  process.exit(1);
});
