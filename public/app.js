import { Net } from './net.js';
import { sfx, setSoundEnabled, unlockAudio } from './sound.js';
import { GAMES, gameById, playableGame } from './catalog.js';

const $ = (id) => document.getElementById(id);
const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { T: '10' };
const DIRS = ['south', 'west', 'north', 'east'];   // clockwise from your seat

// ------------------------------------------------------------------ preferences

const PREFS_KEY = 'st-spades:prefs';
const SESSION_KEY = 'st-spades:session';
const GAME_SETTINGS_KEY = 'st-spades:rules';
const SESSION_TTL = 6 * 60 * 60 * 1000;

// Top right is where iOS parks the FaceTime window by default, so that is where
// the table expects it until the player says otherwise.
const defaultPrefs = {
  name: '', ft: 'tr', ftChosen: false,
  quickPlay: false, sound: true, bigCards: false, wakeLock: true,
};

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch { return { ...fallback }; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const prefs = loadJSON(PREFS_KEY, defaultPrefs);
// Anyone who never picked a corner gets the new default rather than the old one.
if (!prefs.ftChosen) prefs.ft = defaultPrefs.ft;
const savePrefs = () => saveJSON(PREFS_KEY, prefs);

/** House rules are remembered per game, so a regular table starts where it left off. */
function loadGameSettings(gameId) {
  const saved = loadJSON(GAME_SETTINGS_KEY, {})[gameId];
  return saved && typeof saved === 'object' ? saved : null;
}
function saveGameSettings(gameId, settings) {
  if (!gameId || !settings) return;
  const all = loadJSON(GAME_SETTINGS_KEY, {});
  all[gameId] = settings;
  saveJSON(GAME_SETTINGS_KEY, all);
}
function schemaDefaults() {
  const out = {};
  for (const group of app.schema) for (const item of group.items) out[item.key] = item.default;
  return out;
}

// -------------------------------------------------------------------- app state

const net = new Net();
const app = {
  schema: [],
  gameId: null,
  restoredRules: false,
  state: null,
  picked: null,
  prevPhase: null,
  prevTurn: null,
  prevHandNumber: 0,
  wakeLock: null,
};

// ------------------------------------------------------------------ small utils

function toast(message, ms = 2600) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

const cardLabel = (card) => (RANK_LABEL[card[0]] ?? card[0]);
const isRed = (card) => card[1] === 'H' || card[1] === 'D';

function cardNode(card, { playable = false, dim = false, picked = false } = {}) {
  const node = document.createElement('div');
  node.className = 'card' + (isRed(card) ? ' red' : '') +
    (playable ? ' playable' : '') + (dim ? ' dim' : '') + (picked ? ' picked' : '');
  node.dataset.card = card;
  node.innerHTML =
    `<span class="idx"><b>${cardLabel(card)}</b><i>${SUIT_CHAR[card[1]]}</i></span>` +
    `<span class="pip">${SUIT_CHAR[card[1]]}</span>`;
  node.setAttribute('aria-label', `${cardLabel(card)} of ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[card[1]]}`);
  return node;
}

const bidText = (bid) => {
  if (!bid) return '–';
  if (bid.type === 'nil') return 'Nil';
  if (bid.type === 'blind') return 'Blind nil';
  return String(bid.value);
};

const seatName = (seat) => app.state?.seats?.[seat]?.name ?? 'that seat';

/** Screen position for an absolute seat number, from your point of view. */
function dirFor(seat) {
  const you = app.state?.youSeat;
  if (you === null || you === undefined) return DIRS[seat];   // spectators watch from seat 0
  return DIRS[(seat - you + 4) % 4];
}

// --------------------------------------------------------------------- screens

function setScreen(name) { document.body.dataset.screen = name; }

function applyDisplayPrefs() {
  document.body.dataset.ft = prefs.ft;
  document.body.classList.toggle('bigcards', prefs.bigCards);
  setSoundEnabled(prefs.sound);
  $('opt-quickplay').checked = prefs.quickPlay;
  $('opt-sound').checked = prefs.sound;
  $('opt-bigcards').checked = prefs.bigCards;
  $('opt-wakelock').checked = prefs.wakeLock;
  for (const btn of $('corner-picker').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.ft === prefs.ft));
  }
  if (prefs.wakeLock) requestWakeLock(); else releaseWakeLock();
}

// -------------------------------------------------------------------- picker

function renderPicker() {
  const grid = $('game-grid');
  grid.innerHTML = '';
  for (const game of GAMES) {
    const ready = game.status === 'playable';
    const tile = document.createElement('button');
    tile.className = `game-tile ${ready ? 'ready' : 'soon'}`;
    tile.dataset.game = game.id;
    tile.innerHTML =
      `<span class="g-chip">${ready ? 'Ready' : 'Soon'}</span>` +
      `<span class="g-mark">${game.mark}</span>` +
      `<span class="g-name">${escapeHtml(game.name)}</span>` +
      `<span class="g-line">${escapeHtml(game.tagline)}</span>` +
      `<span class="g-players">${escapeHtml(game.players)}</span>`;
    grid.appendChild(tile);
  }
}

function selectGame(id) {
  const game = playableGame(id);
  if (!game) {
    const named = gameById(id);
    toast(named ? `${named.name} is not built yet. Spades is ready now.` : 'That game is not ready yet.');
    return;
  }
  app.gameId = game.id;
  $('home-game-name').textContent = game.name;
  $('home-game-blurb').textContent = game.blurb ?? game.tagline;
  setScreen('home');
  history.replaceState(null, '', `/${game.id}`);
  if (!$('input-name').value) $('input-name').focus();
}

function showRejoinOffer(session) {
  const node = $('rejoin');
  const name = gameById(session.gameId)?.name ?? 'table';
  node.innerHTML =
    `<div class="r-text"><strong>Back to your ${escapeHtml(name)} table?</strong>` +
    `<small>You were sitting at ${escapeHtml(session.code)}.</small></div>` +
    `<div class="r-actions"><button class="r-go">Rejoin</button><button class="r-no">No</button></div>`;
  node.hidden = false;

  node.querySelector('.r-go').onclick = () => {
    node.hidden = true;
    net.setRejoin({ code: session.code, name: prefs.name, playerId: session.playerId });
    net.send({ t: 'join', code: session.code, name: prefs.name, playerId: session.playerId });
  };
  node.querySelector('.r-no').onclick = () => {
    node.hidden = true;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  };
}

function showPicker() {
  app.gameId = null;
  renderPicker();
  $('rejoin').hidden = true;
  setScreen('picker');
  history.replaceState(null, '', '/');
}

// --------------------------------------------------------------------- lobby UI

function renderLobby() {
  const s = app.state;
  $('lobby-code').textContent = s.code;
  $('lobby-code-2').textContent = s.code;
  $('lobby-game').textContent = gameById(s.gameId)?.name ?? 'Game';

  const link = `${location.origin}/${s.code}`;
  $('share-link').textContent = link;

  // seats
  const grid = $('seat-grid');
  grid.innerHTML = '';
  for (let seat = 0; seat < 4; seat++) {
    const occupant = s.seats[seat];
    const mine = s.youSeat === seat;
    const div = document.createElement('div');
    div.className = 'seat-card' + (mine ? ' is-you' : '');

    const team = seat % 2 === 0 ? 'Team 1' : 'Team 2';
    const partner = seatName((seat + 2) % 4);
    let nameHtml;
    if (occupant) {
      const tags = [];
      if (occupant.isHost) tags.push('host');
      if (occupant.isBot) tags.push('bot');
      if (mine) tags.push('you');
      nameHtml = `<span class="dot${occupant.connected ? '' : ' off'}"></span>${escapeHtml(occupant.name)}` +
        (tags.length ? `<span class="tag">${tags.join(' · ')}</span>` : '');
    } else {
      nameHtml = '<span class="seat-empty">Open seat</span>';
    }

    const actions = [];
    if (!occupant) {
      actions.push(`<button class="mini go" data-sit="${seat}">Sit here</button>`);
      if (s.isHost) actions.push(`<button class="mini" data-addbot="${seat}">Add a bot</button>`);
    } else if (mine) {
      actions.push('<button class="mini" data-stand="1">Stand up</button>');
    } else if (s.isHost) {
      actions.push(`<button class="mini" data-remove="${seat}">Remove</button>`);
    }

    div.innerHTML =
      `<div><div class="seat-team">${team} · partners with ${escapeHtml(partner)}</div>` +
      `<div class="seat-name">${nameHtml}</div></div>` +
      `<div class="seat-actions">${actions.join('')}</div>`;
    grid.appendChild(div);
  }

  $('rules-lock').textContent = s.isHost
    ? (app.restoredRules ? 'your last settings' : '')
    : `${s.hostName} sets these`;
  $('btn-reset-rules').hidden = !s.isHost;
  renderSettings();

  const watching = s.watching ?? [];
  $('watchers').textContent = watching.length
    ? `Watching: ${watching.map((w) => w.name).join(', ')}`
    : '';

  const startBtn = $('btn-start');
  startBtn.disabled = !(s.isHost && s.canStart);
  const openSeats = s.seats.filter((x) => x === null).length;
  $('start-hint').textContent = !s.isHost
    ? `Waiting for ${s.hostName} to start the game.`
    : openSeats > 0
      ? `${openSeats} seat${openSeats === 1 ? '' : 's'} still open — share the link, or fill them with bots to try it out.`
      : 'Everyone is seated. Deal them in.';
}

function renderSettings() {
  const s = app.state;
  const host = s.isHost;
  const list = $('settings-list');
  list.innerHTML = '';

  for (const group of app.schema) {
    const head = document.createElement('div');
    head.className = 'setting-group-head';
    head.textContent = group.group;
    list.appendChild(head);

    for (const item of group.items) {
      const parentOff = item.dependsOn && !s.settings[item.dependsOn];
      const row = document.createElement('div');
      row.className = 'setting' + (parentOff ? ' disabled' : '');

      const value = s.settings[item.key];
      let control = '';
      if (item.type === 'bool') {
        control = `<button class="switch" role="switch" aria-pressed="${Boolean(value)}" data-key="${item.key}" data-type="bool"></button>`;
      }

      row.innerHTML =
        `<div class="setting-top"><div class="setting-label">${escapeHtml(item.label)}</div>${control}</div>` +
        (item.help ? `<div class="setting-help">${escapeHtml(item.help)}</div>` : '');

      if (item.type === 'choice') {
        const choices = document.createElement('div');
        choices.className = 'choice-row';
        for (const opt of item.options) {
          const b = document.createElement('button');
          b.className = 'choice';
          b.textContent = opt.l;
          b.setAttribute('aria-pressed', String(opt.v === value));
          b.dataset.key = item.key;
          b.dataset.type = 'choice';
          b.dataset.value = JSON.stringify(opt.v);
          choices.appendChild(b);
        }
        row.appendChild(choices);
      }

      if (!host || parentOff) {
        for (const b of row.querySelectorAll('button')) b.disabled = true;
      }
      list.appendChild(row);
    }
  }
}

// --------------------------------------------------------------------- table UI

function renderTable() {
  const s = app.state;
  const g = s.game;

  // score header
  const youTeam = s.youSeat === null ? 0 : s.youSeat % 2;
  const us = $('score-us');
  const them = $('score-them');
  us.classList.add('us');
  us.querySelector('.val').textContent = g.scores[youTeam];
  them.querySelector('.val').textContent = g.scores[1 - youTeam];
  us.querySelector('.bags').textContent = s.settings.bagsEnabled ? `${g.bags[youTeam]} bags` : '';
  them.querySelector('.bags').textContent = s.settings.bagsEnabled ? `${g.bags[1 - youTeam]} bags` : '';

  renderSeatBadges();
  renderTrick();
  renderHand();
  renderBanner();
  renderSheets();
}

function renderSeatBadges() {
  const s = app.state;
  const g = s.game;
  for (let seat = 0; seat < 4; seat++) {
    const node = document.querySelector(`.seat-${dirFor(seat)}`);
    if (!node) continue;
    const occupant = s.seats[seat];
    const active = g.turn === seat && ['blind', 'bidding', 'playing'].includes(g.phase);

    node.classList.toggle('active', active);
    node.classList.toggle('dealer', g.dealer === seat);
    node.classList.toggle('team-a', seat % 2 === 0);
    node.classList.toggle('team-b', seat % 2 === 1);

    const bid = g.bids[seat];
    let bidHtml;
    if (g.phase === 'lobby') bidHtml = '';
    else if (g.phase === 'blind') bidHtml = g.blindChoices[seat] === null ? 'deciding…' : (g.blindChoices[seat] ? '<span class="nil">Blind nil</span>' : 'looking');
    else if (!bid) bidHtml = 'thinking…';
    else if (bid.type !== 'num') {
      const ok = g.tricksWon[seat] === 0;
      bidHtml = `<span class="nil">${bidText(bid)}</span> ${ok ? '✓' : `✕ ${g.tricksWon[seat]}`}`;
    } else {
      const won = g.tricksWon[seat];
      const cls = won > bid.value ? 'over' : won === bid.value ? 'made' : '';
      bidHtml = `<span class="${cls}">${won}</span> / ${bid.value}`;
    }

    node.innerHTML =
      `<div class="s-name${occupant && !occupant.connected ? ' off' : ''}">` +
      `${occupant ? escapeHtml(occupant.name) : 'Empty'}${occupant && !occupant.connected ? ' ⚠' : ''}</div>` +
      `<div class="s-bid">${bidHtml}</div>` +
      `<div class="s-cards">${g.handCounts[seat]} cards</div>`;
  }
}

function renderTrick() {
  const g = app.state.game;
  const wrap = $('trick');
  wrap.innerHTML = '';
  for (const play of g.trick) {
    const node = cardNode(play.card);
    node.classList.add('played', dirFor(play.seat));
    if (g.phase === 'trickEnd' && g.trickWinner === play.seat) node.classList.add('winner');
    wrap.appendChild(node);
  }
}

function renderHand() {
  const s = app.state;
  const g = s.game;
  const wrap = $('hand');
  wrap.innerHTML = '';

  if (g.handHidden) {
    for (let i = 0; i < 13; i++) {
      const back = document.createElement('div');
      back.className = 'card back';
      wrap.appendChild(back);
    }
  } else {
    const legal = new Set(g.legal);
    const myTurn = g.phase === 'playing' && g.turn === s.youSeat;
    for (const card of g.hand) {
      const playable = myTurn && legal.has(card);
      wrap.appendChild(cardNode(card, {
        playable,
        dim: myTurn && !legal.has(card),
        picked: app.picked === card,
      }));
    }
  }
  fitHand();
  renderHandMessage();
}

/** Squeeze the fan so thirteen cards always fit the screen width. */
function fitHand() {
  const wrap = $('hand');
  const count = wrap.children.length;
  if (count < 2) { wrap.style.setProperty('--overlap', '0px'); wrap.classList.remove('tight'); return; }
  const cardW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 46;
  // clientWidth includes padding, which the cards cannot use.
  const pad = getComputedStyle(wrap);
  const padX = (parseFloat(pad.paddingLeft) || 0) + (parseFloat(pad.paddingRight) || 0);
  const available = wrap.clientWidth - padX - 12;
  const needed = count * cardW;
  wrap.classList.toggle('tight', needed > available);
  if (needed <= available) {
    wrap.style.setProperty('--overlap', '2px');
  } else {
    const overlap = (available - cardW) / (count - 1) - cardW;
    wrap.style.setProperty('--overlap', `${Math.max(overlap, -cardW * 0.56).toFixed(1)}px`);
  }
}

function renderHandMessage() {
  const s = app.state;
  const g = s.game;
  const node = $('hand-msg');
  node.classList.remove('you');

  if (g.phase === 'playing' && g.turn === s.youSeat) {
    node.classList.add('you');
    const led = g.trick.length ? g.trick[0].card[1] : null;
    if (led) {
      const hasLed = g.hand.some((c) => c[1] === led);
      node.textContent = hasLed
        ? `Your turn — follow ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[led]}`
        : 'Your turn — you are out of that suit, play anything';
    } else {
      node.textContent = g.spadesBroken || !s.settings.spadesBrokenRequired
        ? 'Your lead — play any card'
        : 'Your lead — spades are not broken yet';
    }
    if (app.picked) node.textContent = `Tap ${cardLabel(app.picked)}${SUIT_CHAR[app.picked[1]]} again to play it`;
  } else if (g.phase === 'playing') {
    node.textContent = `Waiting on ${seatName(g.turn)}…`;
  } else if (g.phase === 'bidding') {
    node.textContent = g.turn === s.youSeat ? 'Place your bid' : `${seatName(g.turn)} is bidding…`;
  } else if (g.phase === 'blind') {
    node.textContent = g.turn === s.youSeat ? 'Blind nil?' : `${seatName(g.turn)} is deciding on blind nil…`;
  } else if (g.phase === 'trickEnd') {
    node.textContent = `${seatName(g.trickWinner)} takes it`;
  } else {
    node.textContent = '';
  }
}

function renderBanner() {
  const g = app.state.game;
  const node = $('banner');
  let text = '';
  if (g.phase === 'trickEnd') {
    text = g.trickWinner === app.state.youSeat
      ? '<strong>You take the trick</strong>'
      : `<strong>${escapeHtml(seatName(g.trickWinner))}</strong> takes the trick`;
  }
  node.innerHTML = text;
  node.classList.toggle('show', Boolean(text));
}

// ------------------------------------------------------------------ bid sheets

function renderSheets() {
  const s = app.state;
  const g = s.game;
  const myTurn = g.turn === s.youSeat;

  $('sheet-blind').hidden = !(g.phase === 'blind' && myTurn && g.canBidBlind);
  $('blind-worth').textContent = s.settings.blindNilValue;

  const showBid = g.phase === 'bidding' && myTurn;
  $('sheet-bid').hidden = !showBid;
  if (showBid) renderBidSheet();

  const showHandEnd = g.phase === 'handEnd';
  $('sheet-hand-end').hidden = !showHandEnd;
  if (showHandEnd) renderHandEnd();

  const showGameEnd = g.phase === 'gameEnd';
  $('sheet-game-end').hidden = !showGameEnd;
  if (showGameEnd) renderGameEnd();
}

function renderBidSheet() {
  const s = app.state;
  const g = s.game;
  const grid = $('bid-grid');
  grid.innerHTML = '';
  for (let n = 1; n <= 13; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.dataset.bid = n;
    b.disabled = n < g.minBid;
    grid.appendChild(b);
  }

  const partnerBid = g.bids[(s.youSeat + 2) % 4];
  const bits = [];
  if (partnerBid) bits.push(`Your partner bid ${bidText(partnerBid).toLowerCase()}.`);
  else bits.push('Your partner has not bid yet.');
  if (g.minBid > 0) bits.push(`Your team must reach ${s.settings.minTeamBid}, so bid at least ${g.minBid}.`);
  bits.push(`Spades in hand: ${g.hand.filter((c) => c[1] === 'S').length}.`);
  $('bid-sub').textContent = bits.join(' ');

  $('btn-nil').hidden = !(s.settings.allowNil && g.minBid === 0);
}

function renderHandEnd() {
  const s = app.state;
  const g = s.game;
  const result = g.lastHandResult;
  if (!result) return;
  const youTeam = s.youSeat === null ? 0 : s.youSeat % 2;

  $('hand-end-title').textContent = `Hand ${result.handNumber}`;
  $('hand-end-body').innerHTML = [youTeam, 1 - youTeam].map((team) => {
    const t = result.teams[team];
    const label = team === youTeam ? 'Us' : 'Them';
    const nilBits = t.nilResults.map((n) =>
      `${escapeHtml(seatName(n.seat))} ${n.type === 'blind' ? 'blind nil' : 'nil'} ${n.made ? `made (+${n.worth})` : `broken (−${n.worth})`}`);
    const detail = [
      `bid ${t.contract}, took ${t.countedTricks}`,
      t.made ? 'made it' : 'set',
      t.bagsGained ? `${t.bagsGained} bag${t.bagsGained === 1 ? '' : 's'}` : null,
      t.bagPenalty ? `bag penalty −${t.bagPenalty}` : null,
      ...nilBits,
    ].filter(Boolean).join(' · ');
    return `<div class="result-row"><div>${label}<div class="detail">${detail}</div></div>` +
      `<div class="result-delta ${t.total >= 0 ? 'pos' : 'neg'}">${t.total >= 0 ? '+' : ''}${t.total}</div></div>`;
  }).join('') +
    `<div class="result-row"><div><strong>Score</strong></div><div class="result-delta">` +
    `${result.scoresAfter[youTeam]} – ${result.scoresAfter[1 - youTeam]}</div></div>`;

  const waiting = [0, 1, 2, 3]
    .filter((seat) => s.seats[seat] && !s.seats[seat].isBot && s.seats[seat].connected && !g.continueReady[seat])
    .map((seat) => seatName(seat));
  $('continue-waiting').textContent = waiting.length ? `Waiting on ${waiting.join(', ')}` : 'Dealing…';
  $('btn-continue').disabled = s.youSeat !== null && g.continueReady[s.youSeat];
}

function renderGameEnd() {
  const s = app.state;
  const g = s.game;
  const youTeam = s.youSeat === null ? 0 : s.youSeat % 2;
  const won = g.winner === youTeam;
  $('game-end-title').textContent = s.youSeat === null
    ? `Team ${g.winner + 1} wins`
    : won ? 'You win!' : 'They got you this time';
  const names = (team) => [team, team + 2].map((x) => seatName(x % 4)).join(' & ');
  $('game-end-body').innerHTML =
    `<p class="sheet-sub">${escapeHtml(names(g.winner))} take it ${g.scores[g.winner]} to ${g.scores[1 - g.winner]} ` +
    `after ${g.historyCount} hand${g.historyCount === 1 ? '' : 's'}.</p>`;
  $('btn-new-game').hidden = !s.isHost;
}

// -------------------------------------------------------------------- overlays

function openOverlay(id) { $(id).hidden = false; }
function closeOverlays() {
  for (const node of document.querySelectorAll('.overlay')) node.hidden = true;
}

function renderScoreboard() {
  const s = app.state;
  const g = s.game;
  const youTeam = s.youSeat === null ? 0 : s.youSeat % 2;
  const history = g.history ?? [];

  let html = `<table class="score-table"><thead><tr><th>Hand</th><th>Us</th><th>Them</th></tr></thead><tbody>`;
  if (history.length === 0) {
    html += `<tr><td colspan="3" style="text-align:left;color:var(--muted)">No hands played yet.</td></tr>`;
  }
  for (const h of history) {
    const a = h.totals[youTeam];
    const b = h.totals[1 - youTeam];
    html += `<tr><td>${h.handNumber}</td>` +
      `<td class="${a >= 0 ? 'pos' : 'neg'}">${a >= 0 ? '+' : ''}${a}</td>` +
      `<td class="${b >= 0 ? 'pos' : 'neg'}">${b >= 0 ? '+' : ''}${b}</td></tr>`;
  }
  html += `</tbody><tfoot><tr><td>Total</td><td>${g.scores[youTeam]}</td><td>${g.scores[1 - youTeam]}</td></tr>`;
  if (s.settings.bagsEnabled) {
    html += `<tr><td>Bags</td><td>${g.bags[youTeam]}</td><td>${g.bags[1 - youTeam]}</td></tr>`;
  }
  html += `</tfoot></table>`;
  html += `<p class="overlay-note" style="margin-top:14px">Playing to ${s.settings.targetScore}.</p>`;
  $('scoreboard-body').innerHTML = html;
}

function renderMenu() {
  const s = app.state;
  const link = `${location.origin}/${s.code}`;
  const ruleBits = [
    `Play to ${s.settings.targetScore}`,
    s.settings.allowNil ? `Nil ${s.settings.nilValue}` : 'No nil',
    s.settings.allowBlindNil ? `Blind nil ${s.settings.blindNilValue}` : null,
    s.settings.bagsEnabled ? `${s.settings.bagLimit} bags = −${s.settings.bagPenalty}` : 'No bags',
    s.settings.minTeamBid ? `Minimum team bid ${s.settings.minTeamBid}` : null,
    s.settings.tenForTwoHundred ? '10-for-200' : null,
    s.settings.spadesBrokenRequired ? 'Spades must be broken' : 'Spades leadable any time',
  ].filter(Boolean);

  const chat = (s.chat ?? []).slice(-8).map((c) =>
    `<div style="font-size:13.5px;margin-bottom:4px"><strong style="color:var(--gold)">${escapeHtml(c.name)}</strong> ${escapeHtml(c.text)}</div>`).join('')
    || '<div class="overlay-note">Nothing yet. You are probably just talking.</div>';

  $('menu-body').innerHTML =
    `<button class="menu-item" data-action="share">Share the table link</button>` +
    `<button class="menu-item" data-action="display">Display &amp; FaceTime corner</button>` +
    `<button class="menu-item" data-action="scores">Scoreboard</button>` +
    `<h4 class="overlay-sub">Table talk</h4><div id="menu-chat">${chat}</div>` +
    `<div style="display:flex;gap:8px;margin-top:8px">` +
    `<input type="text" id="chat-input" maxlength="200" placeholder="Say something" style="flex:1">` +
    `<button class="btn btn-secondary" data-action="send-chat">Send</button></div>` +
    `<h4 class="overlay-sub">House rules</h4>` +
    `<p class="overlay-note">${ruleBits.map(escapeHtml).join(' · ')}</p>` +
    `<p class="overlay-note">Table code <strong style="color:var(--gold);letter-spacing:.2em">${s.code}</strong><br>${escapeHtml(link)}</p>` +
    `<button class="menu-item" data-action="leave" style="color:var(--red);border-color:#5a2a2a">Leave the table</button>`;
}

// ------------------------------------------------------------------- reactions

function reactToState(prev, next) {
  const g = next.game;
  if (!prev) return;
  const p = prev.game;

  if (g.phase === 'trickEnd' && p.phase !== 'trickEnd') sfx.trickWon();
  if (g.phase === 'handEnd' && p.phase !== 'handEnd') sfx.handEnd();
  if (g.trick.length > p.trick.length && g.phase === 'playing') sfx.play();

  const becameMyTurn = g.turn === next.youSeat && (p.turn !== next.youSeat || p.phase !== g.phase);
  if (becameMyTurn && ['bidding', 'playing', 'blind'].includes(g.phase)) {
    sfx.yourTurn();
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch { /* unsupported */ } }
  }

  if (g.handNumber !== p.handNumber) app.picked = null;
}

// ------------------------------------------------------------------ networking

function applyState(next) {
  const prev = app.state;
  app.state = next;

  reactToState(prev, next);

  if (next.game.phase === 'lobby') setScreen('lobby');
  else setScreen('table');

  if (document.body.dataset.screen === 'lobby') renderLobby();
  else renderTable();

  if (!$('overlay-scores').hidden) renderScoreboard();
  if (!$('overlay-menu').hidden) renderMenu();

  // Only the host's choices are worth keeping; a guest is playing someone else's rules.
  if (next.isHost && next.game.phase === 'lobby') saveGameSettings(next.gameId, next.settings);

  saveJSON(SESSION_KEY, { code: next.code, playerId: next.youId, gameId: next.gameId, at: Date.now() });
}

net.addEventListener('joined', (e) => {
  const { playerId, code, gameId, schema } = e.detail;
  // Each game brings its own house rules, so the lobby is built from this.
  if (schema) app.schema = schema;
  if (gameId) app.gameId = gameId;
  net.setRejoin({ code, playerId, name: prefs.name });
  history.replaceState(null, '', `/${code}`);
});

net.addEventListener('state', (e) => applyState(e.detail.state));

net.addEventListener('error', (e) => {
  toast(e.detail.message);
  sfx.error();
});

net.addEventListener('kicked', (e) => {
  toast(e.detail.message ?? 'Disconnected.', 5000);
  net.close();
  showPicker();
});

net.addEventListener('open', () => { $('conn-banner').hidden = true; });
net.addEventListener('close', () => {
  const screen = document.body.dataset.screen;
  if (screen === 'lobby' || screen === 'table') $('conn-banner').hidden = false;
});

// ---------------------------------------------------------------- wake lock

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || app.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
  } catch { /* denied, or the tab is hidden */ }
}
function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch { /* already gone */ }
  app.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (prefs.wakeLock) requestWakeLock();
    net.connect();
  }
});

// -------------------------------------------------------------------- actions

function startGameFlow(mode) {
  const name = $('input-name').value.trim();
  if (!name) { toast('Add your name first so the table knows who you are.'); $('input-name').focus(); return; }
  prefs.name = name;
  savePrefs();
  unlockAudio();

  if (mode === 'create') {
    if (!app.gameId) { showPicker(); return; }
    const saved = loadGameSettings(app.gameId);
    app.restoredRules = Boolean(saved);
    net.send({ t: 'create', name, gameId: app.gameId, settings: saved ?? undefined });
  } else {
    const code = $('input-code').value.trim().toUpperCase();
    if (code.length < 4) { toast('A table code is four letters.'); $('input-code').focus(); return; }
    net.setRejoin({ code, name, playerId: readSessionPlayerId(code) });
    net.send({ t: 'join', code, name, playerId: readSessionPlayerId(code) });
  }
}

function readSessionPlayerId(code) {
  const session = loadJSON(SESSION_KEY, {});
  if (session.code === code && session.at && Date.now() - session.at < SESSION_TTL) return session.playerId;
  return undefined;
}

function playCard(card) {
  if (prefs.quickPlay || app.picked === card) {
    app.picked = null;
    net.send({ t: 'play', card });
  } else {
    app.picked = card;
    renderHand();
  }
}

async function shareLink() {
  const link = `${location.origin}/${app.state.code}`;
  const text = `Join my Spades table — code ${app.state.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Still Together — Spades', text, url: link }); return; } catch { /* cancelled */ }
  }
  copyLink();
}

async function copyLink() {
  const link = `${location.origin}/${app.state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied. Paste it to your table.');
  } catch {
    toast(link, 6000);
  }
}

// ---------------------------------------------------------------------- wiring

$('game-grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.game-tile');
  if (tile) selectGame(tile.dataset.game);
});
$('home-back').addEventListener('click', showPicker);

$('btn-create').addEventListener('click', () => startGameFlow('create'));
$('btn-join').addEventListener('click', () => startGameFlow('join'));
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGameFlow('join'); });
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGameFlow('create'); });

$('btn-share').addEventListener('click', shareLink);
$('btn-copy').addEventListener('click', copyLink);
$('btn-start').addEventListener('click', () => { unlockAudio(); net.send({ t: 'start' }); });
$('lobby-display').addEventListener('click', () => openOverlay('overlay-display'));
$('lobby-leave').addEventListener('click', () => {
  net.send({ t: 'leave' });
  net.close();
  showPicker();
  setTimeout(() => net.connect(), 200);
});

$('seat-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.sit !== undefined) net.send({ t: 'sit', seat: Number(btn.dataset.sit) });
  else if (btn.dataset.stand) net.send({ t: 'stand' });
  else if (btn.dataset.addbot !== undefined) net.send({ t: 'addBot', seat: Number(btn.dataset.addbot) });
  else if (btn.dataset.remove !== undefined) net.send({ t: 'removeSeat', seat: Number(btn.dataset.remove) });
});

$('btn-reset-rules').addEventListener('click', () => {
  net.send({ t: 'settings', patch: schemaDefaults() });
  app.restoredRules = false;
  toast('House rules back to the standard game.');
});

$('settings-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn || btn.disabled) return;
  const key = btn.dataset.key;
  if (btn.dataset.type === 'bool') {
    net.send({ t: 'settings', patch: { [key]: btn.getAttribute('aria-pressed') !== 'true' } });
  } else {
    net.send({ t: 'settings', patch: { [key]: JSON.parse(btn.dataset.value) } });
  }
});

$('hand').addEventListener('click', (e) => {
  const node = e.target.closest('.card.playable');
  if (!node) return;
  unlockAudio();
  playCard(node.dataset.card);
});

$('bid-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-bid]');
  if (!btn || btn.disabled) return;
  net.send({ t: 'bid', bid: { type: 'num', value: Number(btn.dataset.bid) } });
});
$('btn-nil').addEventListener('click', () => net.send({ t: 'bid', bid: { type: 'nil' } }));
$('btn-blind-yes').addEventListener('click', () => net.send({ t: 'blind', blind: true }));
$('btn-blind-no').addEventListener('click', () => net.send({ t: 'blind', blind: false }));
$('btn-continue').addEventListener('click', () => { $('btn-continue').disabled = true; net.send({ t: 'continue' }); });
$('btn-new-game').addEventListener('click', () => net.send({ t: 'newGame' }));

$('table-menu').addEventListener('click', () => { renderMenu(); openOverlay('overlay-menu'); });
$('table-score').addEventListener('click', () => { renderScoreboard(); openOverlay('overlay-scores'); });

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-overlay]')) { closeOverlays(); return; }
  if (e.target.classList.contains('overlay')) closeOverlays();
});

$('menu-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'share') { closeOverlays(); shareLink(); }
  if (action === 'display') { closeOverlays(); openOverlay('overlay-display'); }
  if (action === 'scores') { closeOverlays(); renderScoreboard(); openOverlay('overlay-scores'); }
  if (action === 'send-chat') {
    const input = $('chat-input');
    if (input.value.trim()) { net.send({ t: 'chat', text: input.value }); input.value = ''; }
  }
  if (action === 'leave') {
    closeOverlays();
    net.send({ t: 'leave' });
    net.close();
    showPicker();
    setTimeout(() => net.connect(), 200);
  }
});

$('corner-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ft]');
  if (!btn) return;
  prefs.ft = btn.dataset.ft;
  prefs.ftChosen = true;
  savePrefs();
  applyDisplayPrefs();
});

for (const [id, key] of [['opt-quickplay', 'quickPlay'], ['opt-sound', 'sound'], ['opt-bigcards', 'bigCards'], ['opt-wakelock', 'wakeLock']]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = e.target.checked;
    savePrefs();
    applyDisplayPrefs();
    if (key === 'sound' && e.target.checked) { unlockAudio(); sfx.yourTurn(); }
    if (app.state && document.body.dataset.screen === 'table') renderTable();
  });
}

window.addEventListener('resize', () => { if (app.state && document.body.dataset.screen === 'table') fitHand(); });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ----------------------------------------------------------------------- boot

function boot() {
  applyDisplayPrefs();
  renderPicker();
  $('input-name').value = prefs.name;

  const path = location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const asCode = path.toUpperCase();
  const isRoomCode = /^[A-Z0-9]{4}$/.test(asCode);
  const fromPath = playableGame(path.toLowerCase());

  const session = loadJSON(SESSION_KEY, {});
  const fresh = session.at && Date.now() - session.at < SESSION_TTL;

  net.connect();

  if (isRoomCode) {
    // Someone tapped a shared table link.
    $('input-code').value = asCode;
    if (prefs.name) {
      const playerId = readSessionPlayerId(asCode);
      net.setRejoin({ code: asCode, name: prefs.name, playerId });
      net.send({ t: 'join', code: asCode, name: prefs.name, playerId });
    } else {
      setScreen('home');
      $('home-game-name').textContent = 'Join a table';
      $('home-game-blurb').textContent = `You were invited to table ${asCode}.`;
      $('input-name').focus();
    }
    return;
  }

  if (fromPath) { selectGame(fromPath.id); return; }

  // Refreshing mid-game keeps the /CODE path, so it is handled above. Reaching
  // the root means "take me home" -- offer the way back, do not force it.
  if (fresh && session.code && prefs.name) showRejoinOffer(session);

  setScreen('picker');
}

boot();
