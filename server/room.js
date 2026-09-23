import { randomUUID } from 'node:crypto';
import { GameError } from './game.js';
import { engineFor } from './engines.js';
import { chooseBid, chooseBlind, chooseCard, BOT_NAMES } from './bot.js';

// Letters and digits that survive being read aloud over a phone call.
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
const CODE_LENGTH = 4;

const BOT_THINK_MS = [700, 1400];
const DISCONNECT_GRACE_MS = 25_000;   // a dropped player's turn is covered by a bot after this
const HAND_END_AUTO_MS = 45_000;      // nobody left to press Continue? move on anyway
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const randBetween = ([lo, hi]) => lo + Math.random() * (hi - lo);

export class Room {
  constructor(code, hub, gameId) {
    this.code = code;
    this.hub = hub;
    this.gameId = gameId;
    this.engine = engineFor(gameId);
    if (!this.engine) throw new GameError('That game is not playable yet.');
    this.players = new Map();       // playerId -> player
    this.seats = [null, null, null, null];  // playerId per seat
    this.hostId = null;
    this.settings = this.engine.defaults();
    this.game = this.engine.create(this.settings);
    this.chat = [];
    this.timer = null;
    this.touchedAt = Date.now();
  }

  touch() { this.touchedAt = Date.now(); }
  get isIdle() { return Date.now() - this.touchedAt > ROOM_IDLE_MS; }

  get humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  get seatedPlayers() { return this.seats.map((id) => (id ? this.players.get(id) : null)); }
  playerAtSeat(seat) { return this.seats[seat] ? this.players.get(this.seats[seat]) : null; }
  seatOf(playerId) { return this.seats.indexOf(playerId); }

  // ------------------------------------------------------------- membership

  addPlayer({ playerId, name, socket }) {
    this.touch();
    let player = playerId ? this.players.get(playerId) : null;

    if (player && !player.isBot) {
      // Reconnect: the seat was held for them.
      if (player.socket && player.socket !== socket) this.closeSocket(player.socket, 'Opened in another tab.');
      player.socket = socket;
      player.connected = true;
      if (name) player.name = cleanName(name, player.name);
    } else {
      player = {
        id: randomUUID(), name: cleanName(name, 'Player'),
        socket, connected: true, isBot: false, joinedAt: Date.now(),
      };
      this.players.set(player.id, player);
    }

    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = player.id;
    if (this.seatOf(player.id) === -1) this.autoSeat(player.id);
    return player;
  }

  autoSeat(playerId) {
    if (this.game.state.phase !== 'lobby') return;   // mid-game arrivals watch
    const open = this.seats.indexOf(null);
    if (open !== -1) this.seats[open] = playerId;
  }

  sit(playerId, seat) {
    if (this.game.state.phase !== 'lobby') throw new GameError('You can only change seats between games.');
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new GameError('That is not a seat.');
    if (this.seats[seat] && this.seats[seat] !== playerId) throw new GameError('That seat is taken.');
    const current = this.seatOf(playerId);
    if (current !== -1) this.seats[current] = null;
    this.seats[seat] = playerId;
  }

  stand(playerId) {
    if (this.game.state.phase !== 'lobby') throw new GameError('You can only leave your seat between games.');
    const seat = this.seatOf(playerId);
    if (seat !== -1) this.seats[seat] = null;
  }

  addBot(seat) {
    if (this.game.state.phase !== 'lobby') throw new GameError('Bots can only join between games.');
    if (this.seats[seat]) throw new GameError('That seat is taken.');
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${seat + 1}`;
    const bot = { id: randomUUID(), name, socket: null, connected: true, isBot: true };
    this.players.set(bot.id, bot);
    this.seats[seat] = bot.id;
  }

  removeSeat(seat, byPlayerId) {
    if (this.game.state.phase !== 'lobby') throw new GameError('You can only change the table between games.');
    if (byPlayerId !== this.hostId) throw new GameError('Only the host can do that.');
    const id = this.seats[seat];
    if (!id) return;
    const player = this.players.get(id);
    this.seats[seat] = null;
    if (player?.isBot) this.players.delete(id);
  }

  disconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.socket = null;
    if (this.game.state.phase === 'lobby' && this.seatOf(playerId) !== -1) {
      // Nothing is at stake before the deal, so free the seat up for someone else.
      this.seats[this.seatOf(playerId)] = null;
    }
    if (this.hostId === playerId) {
      const heir = this.humans.find((p) => p.connected);
      if (heir) this.hostId = heir.id;
    }
  }

  // ------------------------------------------------------------------ actions

  requireSeat(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) throw new GameError('You are watching this game, not playing it.');
    return seat;
  }

  updateSettings(playerId, patch) {
    if (playerId !== this.hostId) throw new GameError('Only the host can change the house rules.');
    if (this.game.state.phase !== 'lobby') throw new GameError('House rules are locked once a game starts.');
    this.settings = this.engine.sanitize(patch, this.settings);
    this.game.settings = this.settings;
  }

  startGame(playerId) {
    if (playerId !== this.hostId) throw new GameError('Only the host can start the game.');
    if (this.seats.some((s) => s === null)) throw new GameError('All four seats need a player or a bot.');
    if (this.game.state.phase !== 'lobby') throw new GameError('A game is already running.');
    this.game.settings = this.settings;
    this.game.startGame();
    this.scheduleAuto();
  }

  newGame(playerId) {
    if (playerId !== this.hostId) throw new GameError('Only the host can start a new game.');
    if (this.game.state.phase !== 'gameEnd') throw new GameError('Finish this game first.');
    this.clearTimer();
    this.game = this.engine.create(this.settings);
    this.game.state.phase = 'lobby';
  }

  act(playerId, msg) {
    const seat = this.requireSeat(playerId);
    const g = this.game;
    switch (msg.t) {
      case 'blind': g.chooseBlind(seat, Boolean(msg.blind)); break;
      case 'bid': g.placeBid(seat, msg.bid ?? {}); break;
      case 'play': g.playCard(seat, String(msg.card ?? '')); break;
      case 'continue': this.markContinue(seat); break;
      default: throw new GameError('Unknown action.');
    }
    this.scheduleAuto();
  }

  markContinue(seat) {
    const g = this.game;
    if (g.state.phase !== 'handEnd') return;
    g.state.continueReady[seat] = true;
    const waitingOn = [0, 1, 2, 3].filter((s) => {
      const p = this.playerAtSeat(s);
      return p && !p.isBot && p.connected && !g.state.continueReady[s];
    });
    if (waitingOn.length === 0) g.nextHand();
  }

  // ------------------------------------------------- automatic play (bots, timers)

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Work out whether the table is waiting on something the server should do itself. */
  scheduleAuto() {
    this.clearTimer();
    const g = this.game;
    const s = g.state;

    if (s.phase === 'trickEnd') {
      this.timer = setTimeout(() => {
        this.timer = null;
        g.resolveTrick();
        this.broadcast();
        this.scheduleAuto();
      }, this.settings.trickPauseMs);
      return;
    }

    if (s.phase === 'handEnd') {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (g.state.phase === 'handEnd') { g.nextHand(); this.broadcast(); this.scheduleAuto(); }
      }, HAND_END_AUTO_MS);
      return;
    }

    if (s.phase !== 'blind' && s.phase !== 'bidding' && s.phase !== 'playing') return;

    const actor = this.playerAtSeat(s.turn);
    if (!actor) return;
    const isBot = actor.isBot;
    if (!isBot && actor.connected) return;         // a live human: wait for them

    const delay = isBot ? randBetween(BOT_THINK_MS) : DISCONNECT_GRACE_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.takeAutoTurn(); } catch { /* state moved on under us; the next broadcast resyncs */ }
      this.broadcast();
      this.scheduleAuto();
    }, delay);
  }

  takeAutoTurn() {
    const g = this.game;
    const seat = g.state.turn;
    const actor = this.playerAtSeat(seat);
    if (!actor) return;
    if (!actor.isBot && actor.connected) return;   // they came back in time

    switch (g.state.phase) {
      case 'blind': g.chooseBlind(seat, chooseBlind(g, seat)); break;
      case 'bidding': g.placeBid(seat, chooseBid(g, seat)); break;
      case 'playing': g.playCard(seat, chooseCard(g, seat)); break;
      default: break;
    }
  }

  // --------------------------------------------------------------------- views

  addChat(playerId, text) {
    const clean = String(text ?? '').slice(0, 300).trim();
    if (!clean) return null;
    const player = this.players.get(playerId);
    const entry = { name: player?.name ?? 'Someone', seat: this.seatOf(playerId), text: clean, ts: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 60) this.chat.shift();
    return entry;
  }

  viewFor(playerId) {
    const seat = this.seatOf(playerId);
    const g = this.game;
    return {
      code: this.code,
      gameId: this.gameId,
      youId: playerId,
      youSeat: seat === -1 ? null : seat,
      isHost: playerId === this.hostId,
      hostName: this.players.get(this.hostId)?.name ?? '',
      settings: this.settings,
      seats: this.seats.map((id) => {
        if (!id) return null;
        const p = this.players.get(id);
        return { name: p.name, connected: p.connected, isBot: p.isBot, isHost: p.id === this.hostId };
      }),
      watching: this.humans
        .filter((p) => this.seatOf(p.id) === -1 && p.connected)
        .map((p) => ({ name: p.name })),
      canStart: this.seats.every((s) => s !== null) && g.state.phase === 'lobby',
      chat: this.chat.slice(-30),
      game: g.viewFor(seat === -1 ? null : seat),
    };
  }

  broadcast() {
    this.touch();
    for (const player of this.players.values()) {
      if (player.isBot || !player.socket) continue;
      this.hub.send(player.socket, { t: 'state', state: this.viewFor(player.id) });
    }
  }

  closeSocket(socket, reason) {
    try { this.hub.send(socket, { t: 'kicked', message: reason }); socket.close(); } catch { /* already gone */ }
  }
}

function cleanName(raw, fallback) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return name || fallback;
}

export function makeRoomCode(exists) {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!exists(code)) return code;
  }
  throw new Error('Could not allocate a free room code.');
}

export { GameError };
