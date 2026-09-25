// End-to-end check: four real browsers, one table, a full hand played through
// the interface. Needs a server already running and Playwright available:
//
//   npm start                       # in another terminal
//   npx playwright install chromium
//   npm run test:e2e
//
// BASE_URL overrides the target; CHROMIUM_PATH overrides the browser binary.

import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const iphone = devices['iPhone 13'];
const fails = [];
const ok = (label) => console.log(`  PASS  ${label}`);
const bad = (label, detail) => { fails.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function newPhone(name) {
  const ctx = await browser.newContext({ ...iphone, permissions: [] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => bad(`JS error in ${name}`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') bad(`console error in ${name}`, m.text()); });
  return { ctx, page, name };
}

console.log('\n--- 0. The game picker ------------------------------------------');
const host = await newPhone('host');
await host.page.goto(BASE);
await host.page.waitForSelector('body[data-screen="picker"]', { timeout: 5000 });

const ftDefault = await host.page.$eval('body', (b) => b.dataset.ft);
ftDefault === 'tr' ? ok('a fresh phone reserves the top-right corner by default') : bad('default corner', ftDefault);

// The window floats over the whole app, so the reserve must be on the picker too.
const pickerReserve = await host.page.$eval('#ft-reserve', (n) => {
  const r = n.getBoundingClientRect();
  return {
    shown: getComputedStyle(n).display !== 'none',
    fixed: getComputedStyle(n).position === 'fixed',
    fromTop: Math.round(r.top),
    fromRight: Math.round(window.innerWidth - r.right),
  };
});
pickerReserve.shown && pickerReserve.fixed
  ? ok(`reserve is on the home screen too, pinned to the viewport (${pickerReserve.fromTop}px from top, ${pickerReserve.fromRight}px from right)`)
  : bad('reserve not present/fixed on the picker', JSON.stringify(pickerReserve));

// Nothing tappable may sit underneath it, on any screen.
const overlapOn = async (page, label) => page.evaluate((lbl) => {
  const ft = document.getElementById('ft-reserve').getBoundingClientRect();
  const hits = [];
  for (const el of document.querySelectorAll('button, input, a, .game-tile, .card')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.closest('[hidden]') || el.offsetParent === null) continue;
    const inter = Math.max(0, Math.min(ft.right, r.right) - Math.max(ft.left, r.left)) *
                  Math.max(0, Math.min(ft.bottom, r.bottom) - Math.max(ft.top, r.top));
    if (inter > 120) hits.push(`${lbl}:${el.id || el.className.split(' ')[0]}`);
  }
  return hits;
}, label);

const pickerHits = await overlapOn(host.page, 'picker');
pickerHits.length === 0 ? ok('nothing tappable on the picker sits under the window') : bad('picker overlap', pickerHits.join(', '));
await host.page.screenshot({ path: 'e2e-picker.png' });

const tiles = await host.page.$$eval('.game-tile', (n) => n.map((t) => ({
  id: t.dataset.game,
  name: t.querySelector('.g-name').textContent,
  ready: t.classList.contains('ready'),
})));
tiles.length === 8 ? ok(`picker lists all eight games: ${tiles.map((t) => t.name).join(', ')}`) : bad('tile count', String(tiles.length));
const ready = tiles.filter((t) => t.ready).map((t) => t.id);
JSON.stringify(ready) === '["spades"]' ? ok('spades is the only one marked Ready') : bad('ready tiles', JSON.stringify(ready));

// An unbuilt game says so instead of opening an empty table.
await host.page.click('.game-tile[data-game="chess"]');
await host.page.waitForTimeout(250);
const stillPicker = await host.page.$eval('body', (b) => b.dataset.screen);
const toastText = await host.page.textContent('#toast').catch(() => '');
stillPicker === 'picker' && /not built yet/i.test(toastText)
  ? ok(`tapping Chess stays put and explains: "${toastText.trim()}"`)
  : bad('unbuilt game did not hold', `screen=${stillPicker} toast=${toastText}`);

console.log('\n--- 1. Host creates a table -------------------------------------');
await host.page.click('.game-tile[data-game="spades"]');
await host.page.waitForSelector('body[data-screen="home"]', { timeout: 5000 });
const homeTitle = await host.page.textContent('#home-game-name');
homeTitle.trim() === 'Spades' ? ok('Spades opens its own start screen') : bad('home title', homeTitle);
await host.page.fill('#input-name', 'Zach');
await host.page.click('#btn-create');
await host.page.waitForSelector('body[data-screen="lobby"]', { timeout: 5000 });
const code = (await host.page.textContent('#lobby-code')).trim();
/^[A-Z0-9]{4}$/.test(code) ? ok(`got a 4-character table code (${code})`) : bad('table code shape', code);

const shareLink = (await host.page.textContent('#share-link')).trim();
shareLink === `${BASE}/${code}` ? ok('share link points at the table') : bad('share link', shareLink);

console.log('\n--- 2. Three friends join by link -------------------------------');
const friends = [];
for (const name of ['Maya', 'Dre', 'Sam']) {
  const p = await newPhone(name);
  await p.page.goto(`${BASE}/${code}`);
  await p.page.waitForSelector('body[data-screen="home"]', { timeout: 5000 });
  await p.page.fill('#input-name', name);
  await p.page.click('#btn-join');
  await p.page.waitForSelector('body[data-screen="lobby"]', { timeout: 5000 });
  friends.push(p);
}
await host.page.waitForTimeout(400);
const seatNames = await host.page.$$eval('.seat-card .seat-name', (n) => n.map((x) => x.textContent.trim()));
seatNames.length === 4 && seatNames.every((s) => !s.includes('Open seat'))
  ? ok(`all four seats filled: ${seatNames.map((s) => s.split('host')[0].trim()).join(', ')}`)
  : bad('seating', JSON.stringify(seatNames));

console.log('\n--- 3. Only the host can change house rules ---------------------');
const guestDisabled = await friends[0].page.$$eval('#settings-list button', (b) => b.every((x) => x.disabled));
guestDisabled ? ok('guests see the rules but cannot change them') : bad('guest could edit rules');
const hostEnabled = await host.page.$$eval('#settings-list button[data-key="targetScore"]', (b) => b.some((x) => !x.disabled));
hostEnabled ? ok('host can change the rules') : bad('host rules locked');

// Host switches the target score and turns blind nil on.
await host.page.click('#settings-list button[data-key="targetScore"][data-value="200"]');
await host.page.click('#settings-list button[data-key="trickPauseMs"][data-value="1200"]');
await host.page.waitForTimeout(250);
const guestSeesChange = await friends[1].page.$eval(
  '#settings-list button[data-key="targetScore"][data-value="200"]', (b) => b.getAttribute('aria-pressed'));
guestSeesChange === 'true' ? ok('a rule change reaches every phone') : bad('rule change not propagated', guestSeesChange);

console.log('\n--- 4. Start the game and play a full hand ----------------------');
await host.page.click('#btn-start');
await host.page.waitForTimeout(700);
await host.page.screenshot({ path: 'e2e-bidding.png' });
await host.page.waitForSelector('body[data-screen="table"]', { timeout: 5000 });
ok('game started, table screen is up');

const everyone = [host, ...friends];
for (const p of everyone) {
  await p.page.waitForSelector('body[data-screen="table"]', { timeout: 5000 });
}

const handCount = await host.page.$$eval('#hand .card', (c) => c.length);
handCount === 13 ? ok('thirteen cards dealt') : bad('hand size', String(handCount));

// Each phone only ever knows its own cards.
const allHands = [];
for (const p of everyone) {
  allHands.push(await p.page.$$eval('#hand .card', (c) => c.map((x) => x.dataset.card)));
}
const flat = allHands.flat();
new Set(flat).size === 52 ? ok('the four hands are a full, non-overlapping deck') : bad('deck integrity', String(new Set(flat).size));

// Drive bidding + the whole hand through the UI.
let capturedHandEnd = '';

// The DOM re-renders on every broadcast, so use locators (which re-resolve)
// rather than element handles (which go stale mid-click).
async function tryClick(page, selector, timeout = 2500) {
  try { await page.locator(selector).first().click({ timeout }); return true; }
  catch { return false; }
}

async function step() {
  for (const p of everyone) {
    if (await p.page.locator('#sheet-bid:not([hidden])').count()) {
      if (await tryClick(p.page, '#bid-grid button:not([disabled])')) return `bid by ${p.name}`;
    }
    if (await p.page.locator('#sheet-blind:not([hidden])').count()) {
      if (await tryClick(p.page, '#btn-blind-no')) return `blind answer by ${p.name}`;
    }
    if (await p.page.locator('#hand .card.playable').count()) {
      if (await tryClick(p.page, '#hand .card.playable')) {
        // Default is tap-to-pick, tap-again-to-play.
        if (await p.page.locator('#hand .card.picked').count()) {
          await tryClick(p.page, '#hand .card.picked');
        }
        return `card by ${p.name}`;
      }
    }
    if (await p.page.locator('#sheet-hand-end:not([hidden]) #btn-continue:not([disabled])').count()) {
      // Grab the scoreboard before it is dismissed.
      if (p === host && !capturedHandEnd) {
        capturedHandEnd = await host.page.textContent('#hand-end-body').catch(() => '');
        await host.page.screenshot({ path: 'e2e-handend.png' });
      }
      if (await tryClick(p.page, '#sheet-hand-end:not([hidden]) #btn-continue:not([disabled])')) return `continue by ${p.name}`;
    }
  }
  return null;
}

let actions = 0;
let sawHandEnd = false;
let refreshChecked = false;
const deadline = Date.now() + 150000;

while (Date.now() < deadline) {
  // Partway through the hand, yank a phone offline and bring it back.
  if (!refreshChecked && actions >= 12) {
    refreshChecked = true;
    console.log('\n--- 5. Refresh mid-hand keeps your seat and your cards ----------');
    // Let any in-flight play settle so the snapshot is not stale.
    const readHand = () => friends[0].page.$$eval('#hand .card', (c) => c.map((x) => x.dataset.card));
    let before = await readHand();
    for (let i = 0; i < 12; i++) {
      await friends[0].page.waitForTimeout(250);
      const again = await readHand();
      if (again.length === before.length && again.every((c, j) => c === before[j])) break;
      before = again;
    }
    await friends[0].page.reload();
    await friends[0].page.waitForSelector('body[data-screen="table"]', { timeout: 10000 });
    await friends[0].page.waitForTimeout(800);
    const after = await friends[0].page.$$eval('#hand .card', (c) => c.map((x) => x.dataset.card));
    const same = after.length > 0 && after.length === before.length && after.every((c, i) => c === before[i]);
    same
      ? ok(`reconnected into the same seat with the same ${after.length} cards`)
      : bad('hand changed across a refresh', `before ${before.length}, after ${after.length}`);
    console.log('\n--- 4b. ...and the hand plays on --------------------------------');
  }

  const did = await step();
  if (did) { actions++; continue; }

  if (capturedHandEnd) sawHandEnd = true;
  if (await host.page.locator('#sheet-hand-end:not([hidden])').count()) sawHandEnd = true;
  if (await host.page.locator('#sheet-game-end:not([hidden])').count()) break;
  if (sawHandEnd && actions >= 56) break;
  await host.page.waitForTimeout(200);
}

actions >= 56 ? ok(`played through the UI: ${actions} actions (4 bids + 52 cards minimum)`) : bad('not enough actions', String(actions));
sawHandEnd ? ok('hand-end scoreboard appeared with the score breakdown') : bad('no hand-end sheet');

if (sawHandEnd) {
  const body = capturedHandEnd || (await host.page.textContent('#hand-end-body').catch(() => ''));
  console.log(`        scoreboard said: ${body.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  /bid \d+, took \d+/.test(body) ? ok('scoreboard explains the bid and the tricks taken') : bad('hand-end detail', body.slice(0, 160));
  /(made it|set)/.test(body) ? ok('scoreboard says whether the contract was made') : bad('no made/set wording');
}

const scoreText = await host.page.textContent('#score-us .val');
const scoreNum = Number(scoreText);
Number.isFinite(scoreNum) && scoreNum !== 0
  ? ok(`score updated after the hand: Us ${scoreText}`)
  : bad('score did not move off zero', scoreText);

console.log('\n--- 5b. Scoreboard is complete on a phone that reconnected ------');
await friends[0].page.click('#table-score');
await friends[0].page.waitForTimeout(300);
const boardRows = await friends[0].page.$$eval('#scoreboard-body tbody tr', (r) => r.length);
const boardText = await friends[0].page.textContent('#scoreboard-body');
boardRows >= 1 && !/No hands played yet/.test(boardText)
  ? ok(`scoreboard lists ${boardRows} hand(s) even though this phone refreshed mid-game`)
  : bad('scoreboard empty after reconnect', boardText.slice(0, 80));
await friends[0].page.screenshot({ path: 'e2e-scoreboard.png' });
await friends[0].page.evaluate(() => document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; }));

console.log('\n--- 6. FaceTime corner reserves space ---------------------------');
const tableHits = await overlapOn(host.page, 'table');
tableHits.length === 0 ? ok('nothing tappable at the table sits under the window') : bad('table overlap', tableHits.join(', '));

// Moving it to a bottom corner has to shift the hand, not just the seats.
await host.page.click('#table-menu');
await host.page.click('[data-action="display"]');
await host.page.click('#corner-picker button[data-ft="br"]');
await host.page.evaluate(() => document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; }));
await host.page.waitForTimeout(400);
const brHits = await overlapOn(host.page, 'table-br');
brHits.length === 0 ? ok('and the same with the window in the bottom-right') : bad('bottom-right overlap', brHits.join(', '));

await host.page.click('#table-menu');
await host.page.click('[data-action="display"]');
await host.page.click('#corner-picker button[data-ft="tr"]');
await host.page.waitForTimeout(350);
const ftBox = await host.page.$eval('#ft-reserve', (n) => {
  const r = n.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), visible: getComputedStyle(n).display !== 'none', top: Math.round(r.top), right: Math.round(window.innerWidth - r.right) };
});
ftBox.visible && ftBox.w > 100 ? ok(`reserved corner is ${ftBox.w}x${ftBox.h} at top-right`) : bad('ft reserve', JSON.stringify(ftBox));

// The reserved box must not sit on top of a seat badge.
const overlap = await host.page.evaluate(() => {
  const ft = document.getElementById('ft-reserve').getBoundingClientRect();
  const hits = [];
  for (const s of document.querySelectorAll('.seat')) {
    const r = s.getBoundingClientRect();
    if (r.width === 0) continue;
    const inter = Math.max(0, Math.min(ft.right, r.right) - Math.max(ft.left, r.left)) *
                  Math.max(0, Math.min(ft.bottom, r.bottom) - Math.max(ft.top, r.top));
    if (inter > 40) hits.push({ seat: s.className, inter: Math.round(inter) });
  }
  return hits;
});
overlap.length === 0 ? ok('no seat badge sits under the FaceTime window') : bad('seat overlaps FaceTime area', JSON.stringify(overlap));
await host.page.evaluate(() => document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; }));

console.log('\n--- 7. No horizontal scroll on a phone --------------------------');
for (const p of everyone) {
  const over = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) bad(`horizontal overflow on ${p.name}`, `${over}px`);
}
if (!fails.some((f) => f.includes('horizontal'))) ok('no page scrolls sideways at iPhone width');

await host.page.screenshot({ path: 'e2e-table.png' });
await friends[0].page.screenshot({ path: 'e2e-table-2.png' });
console.log('\n--- 8. The root always goes home, with a way back ---------------');
await host.page.goto(BASE);
await host.page.waitForSelector('body[data-screen="picker"]', { timeout: 8000 });
ok('visiting the root lands on the picker, not back in the old table');
await host.page.waitForTimeout(300);
const rejoinVisible = await host.page.$eval('#rejoin', (n) => !n.hidden).catch(() => false);
const rejoinText = rejoinVisible ? (await host.page.textContent('#rejoin')).replace(/\s+/g, ' ').trim() : '';
rejoinVisible && /Back to your Spades table/.test(rejoinText)
  ? ok(`and offers the way back: "${rejoinText.slice(0, 60)}"`)
  : bad('no rejoin offer on the picker', rejoinText);

await host.page.click('#rejoin .r-go');
await host.page.waitForSelector('body[data-screen="table"], body[data-screen="lobby"]', { timeout: 8000 });
ok('tapping Rejoin puts you back at the table');

await host.page.goto(BASE);
await host.page.waitForSelector('body[data-screen="picker"]');
await host.page.click('#rejoin .r-no');
await host.page.waitForTimeout(200);
const dismissed = await host.page.$eval('#rejoin', (n) => n.hidden);
dismissed ? ok('and "No" clears it') : bad('rejoin offer would not dismiss');
await host.page.screenshot({ path: 'e2e-home.png' });

console.log('\n--- 9. House rules are remembered for next time -----------------');
// Section 3 set "play to 200" and a 1.2s trick pause on the first table.
await host.page.goto(BASE);
await host.page.waitForSelector('body[data-screen="picker"]', { timeout: 8000 });
await host.page.click('.game-tile[data-game="spades"]');
await host.page.waitForSelector('body[data-screen="home"]');
await host.page.click('#btn-create');
await host.page.waitForSelector('body[data-screen="lobby"]', { timeout: 8000 });
await host.page.waitForTimeout(400);

const newCode = (await host.page.textContent('#lobby-code')).trim();
const restored = await host.page.evaluate(() => ({
  target: document.querySelector('#settings-list button[data-key="targetScore"][aria-pressed="true"]')?.textContent,
  pause: document.querySelector('#settings-list button[data-key="trickPauseMs"][aria-pressed="true"]')?.textContent,
  note: document.getElementById('rules-lock')?.textContent.trim(),
}));
restored.target === '200' && restored.pause === '1.2s'
  ? ok(`a brand new table (${newCode}) opens with the last rules used: play to ${restored.target}, ${restored.pause} trick pause`)
  : bad('house rules were not remembered', JSON.stringify(restored));
/last settings/i.test(restored.note ?? '')
  ? ok(`and says so: "${restored.note}"`)
  : bad('no note explaining the restored rules', restored.note);

await host.page.click('#btn-reset-rules');
await host.page.waitForTimeout(400);
const afterReset = await host.page.$eval('#settings-list button[data-key="targetScore"][aria-pressed="true"]', (b) => b.textContent);
afterReset === '500' ? ok('Reset puts the standard game back (play to 500)') : bad('reset did not restore defaults', afterReset);
await host.page.screenshot({ path: 'e2e-lobby-rules.png' });

console.log('\n================================================================');
console.log(fails.length === 0 ? 'ALL CHECKS PASSED' : `${fails.length} FAILURE(S): ${fails.join(' | ')}`);
await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
