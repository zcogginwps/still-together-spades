import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, makeRoomCode, GameError } from './room.js';
import { GAMES, playableGame, DEFAULT_GAME } from '../public/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ------------------------------------------------------------------ static files

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, rel);
  // Refuse anything that escapes the public directory.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown paths fall through to the app so /ABCD style links work.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(html);
      });
      return;
    }
    const ext = path.extname(filePath);
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache }).end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
  if (req.url === '/api/games') {
    res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(GAMES));
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------------- sockets

const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const hub = {
  send(socket, payload) {
    if (socket.readyState === socket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* socket died mid-write */ }
    }
  },
};

const getRoom = (code) => rooms.get(String(code ?? '').toUpperCase().trim());

function fail(socket, message) {
  hub.send(socket, { t: 'error', message });
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  let room = null;
  let playerId = null;

  hub.send(socket, { t: 'hello', games: GAMES });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return fail(socket, 'Bad message.'); }
    if (!msg || typeof msg.t !== 'string') return fail(socket, 'Bad message.');

    try {
      // ---- joining ----
      if (msg.t === 'create') {
        const gameId = String(msg.gameId ?? DEFAULT_GAME);
        const game = playableGame(gameId);
        if (!game) throw new GameError('That game is not playable yet.');
        const code = makeRoomCode((c) => rooms.has(c));
        room = new Room(code, hub, gameId);
        rooms.set(code, room);
        const player = room.addPlayer({ name: msg.name, socket });
        playerId = player.id;
        if (msg.settings) room.updateSettings(playerId, msg.settings);
        hub.send(socket, { t: 'joined', playerId, code, gameId, schema: room.engine.schema });
        room.broadcast();
        return;
      }

      if (msg.t === 'join') {
        const target = getRoom(msg.code);
        if (!target) return fail(socket, 'No game with that code. Check the letters and try again.');
        if (room && room !== target) { room.disconnect(playerId); room.broadcast(); }
        room = target;
        const player = room.addPlayer({ playerId: msg.playerId, name: msg.name, socket });
        playerId = player.id;
        hub.send(socket, { t: 'joined', playerId, code: room.code, gameId: room.gameId, schema: room.engine.schema });
        room.broadcast();
        return;
      }

      if (!room || !playerId) return fail(socket, 'Join a game first.');
      room.touch();

      // ---- table management ----
      switch (msg.t) {
        case 'sit': room.sit(playerId, msg.seat); break;
        case 'stand': room.stand(playerId); break;
        case 'addBot': {
          if (playerId !== room.hostId) throw new GameError('Only the host can add a bot.');
          room.addBot(msg.seat);
          break;
        }
        case 'removeSeat': room.removeSeat(msg.seat, playerId); break;
        case 'settings': room.updateSettings(playerId, msg.patch ?? {}); break;
        case 'start': room.startGame(playerId); break;
        case 'newGame': room.newGame(playerId); break;
        case 'rename': {
          const player = room.players.get(playerId);
          if (player) player.name = String(msg.name ?? '').trim().slice(0, 18) || player.name;
          break;
        }
        case 'chat': {
          const entry = room.addChat(playerId, msg.text);
          if (!entry) return;
          break;
        }
        case 'leave': {
          room.disconnect(playerId);
          // If the table was waiting on them, let a bot cover the turn.
          room.scheduleAuto();
          room.broadcast();
          room = null; playerId = null;
          return;
        }
        case 'ping': hub.send(socket, { t: 'pong' }); return;
        default: room.act(playerId, msg); break;
      }

      room.broadcast();
    } catch (err) {
      if (err instanceof GameError) return fail(socket, err.message);
      console.error('[ws] unhandled', err);
      return fail(socket, 'Something went wrong on the table.');
    }
  });

  socket.on('close', () => {
    if (room && playerId) {
      room.disconnect(playerId);
      room.scheduleAuto();
      room.broadcast();
    }
  });

  socket.on('error', () => { /* close handler does the cleanup */ });
});

// Drop sockets that stopped answering, and sweep abandoned rooms.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    try { socket.ping(); } catch { /* going away anyway */ }
  }
  for (const [code, room] of rooms) {
    const anyoneHere = room.humans.some((p) => p.connected);
    if (!anyoneHere && room.isIdle) { room.clearTimer(); rooms.delete(code); }
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`Still Together - Spades listening on http://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) room.clearTimer();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server, rooms };
