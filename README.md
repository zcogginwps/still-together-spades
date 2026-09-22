# Still Together &mdash; Spades

Part of the **Still Together** series: small games built for people who are already
on a call together, and just want something to do with their hands while they talk.

This one is Spades. Four people, one FaceTime call, one deck. One person starts a
table and sends a link; the other three tap it and sit down. No accounts, no app
install, no downloads.

> **Status: beta.** Playable end to end, but not yet battle-tested by real tables.

---

## How a game goes

1. Start your FaceTime call with the other three players, as you normally would.
2. One of you opens the site and taps **Start a new game**.
3. They tap **Share link** and send it to the group. Everyone else taps it.
4. Swipe up to your home screen so FaceTime shrinks to its small floating window,
   then drag that window into a corner.
5. In the game, open the menu and tell it which corner &mdash; the table keeps that
   corner clear. Everyone picks their own; it is a per-phone setting.
6. The host sets the house rules and taps **Start the game**.

A four-letter table code is shown too, for anyone who would rather type it than
tap a link.

## Why not SharePlay?

SharePlay is the native way to share an activity inside a FaceTime call, and it is
genuinely nicer &mdash; the game would sit beside the call rather than under it. It
needs a real iOS app, an Apple Developer account, and App Store review, so it is
the wrong shape for a beta you want to test this weekend. A web page you can send
to anyone, on any phone, is the fastest route to finding out whether the game is
fun. If it is, SharePlay is the obvious next step and nothing here is wasted:
the rules engine and the server would carry straight over.

The reserved-corner approach was chosen over the alternatives for a reason:

- **Reserved corner (what this does).** Works on every phone, costs nothing, and
  the FaceTime window is draggable anyway so people can put it where they like.
- **Embedding the video in the page.** Would mean rebuilding the call in WebRTC and
  giving up FaceTime entirely &mdash; more moving parts, worse audio, and everyone has
  to grant camera permission.
- **Ignoring it.** The PiP window covers roughly a 130&times;180pt corner. Left
  unhandled it lands on top of a player's bid exactly when you need to read it.

## House rules the host can set

Everything below is set by the host in the lobby and applies to the whole table.
Each one is described in-app, so nobody has to remember what "bags" means.

| Setting | Options | Default |
| --- | --- | --- |
| Play to | 200 / 300 / 500 / 750 / 1000 | 500 |
| Mercy rule | Off / &minus;200 / &minus;300 / &minus;500 | &minus;200 |
| Allow nil | on / off | on |
| Nil is worth | 50 / 100 / 150 | 100 |
| Allow blind nil | on / off | off |
| Blind nil is worth | 100 / 200 / 300 | 200 |
| Blind nil only when behind by | any time / 100 / 150 / 200 | 100 |
| Minimum team bid | none / 4 | none |
| Count bags | on / off | on |
| Bags before penalty | 5 / 10 | 10 |
| Bag penalty | 50 / 100 / 150 | 100 |
| Broken nil helps the team | on / off | off |
| 10-for-200 | on / off | off |
| Spades must be broken | on / off | on |
| Trick stays on screen | 1.2s / 2s / 3s / 4.5s | 2s |

Two of those are worth a word:

- **Broken nil helps the team.** When a nil bidder takes a trick, does it count
  toward their partner's bid, or is it only a bag? Tables disagree; pick yours.
- **Trick stays on screen.** How long the finished trick sits there before it is
  swept. Over a video call people look up, talk, and look back, so the default is
  slower than a typical online card game.

Each player also has their own display settings, which affect nobody else: the
FaceTime corner, one-tap vs. tap-to-confirm card play, sound, larger cards, and
keeping the screen awake.

## Things it already handles

- **Reconnecting.** Lock your phone, take a call, or refresh the page and you drop
  back into the same seat with the same cards.
- **Someone drops out.** If a player's connection dies and the table is waiting on
  them, a bot covers their turn after 25 seconds. They get their seat back the
  moment they return.
- **Testing alone.** The host can fill empty seats with bots, so you can try the
  whole thing by yourself before rounding up three people.
- **Screen dimming.** Optional wake lock, on by default.
- **Spectators.** Anyone who joins a full table watches instead.

## Running it

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules, engine, and a few thousand simulated games
npm run test:e2e   # four real browsers playing a hand (needs the server running)
```

Node 20 or newer. The only runtime dependency is `ws`.

## Deploying the beta

The server is a single Node process holding game state in memory, so it needs a
real host &mdash; GitHub Pages and other static hosts cannot run it.

**Render** (free tier, simplest): push this repo to GitHub, then in Render choose
**New &rarr; Blueprint** and point it at the repo. `render.yaml` sets everything up.
Free instances sleep after inactivity, so the first visitor waits ~30 seconds for
a cold start; after that it is fine for a whole evening.

**Fly.io**: `fly launch --copy-config --now` uses the included `fly.toml` and
`Dockerfile`.

**Anywhere else**: it is a plain Node app. `PORT` is the only environment variable,
and `/healthz` is there for health checks.

One thing to get right wherever you deploy: the host must support **WebSockets**.
All four phones hold an open socket to `/ws`.

## How it is put together

```
server/
  index.js    HTTP + WebSocket server, static file serving
  room.js     tables, seats, reconnection, bot and disconnect timers
  game.js     the Spades state machine (dealing, bidding, tricks, hands)
  rules.js    the house-rules schema, scoring, and win conditions
  bot.js      the fill-in player
  deck.js     cards, shuffling, who won the trick
public/       the client: no build step, no framework, plain ES modules
test/         node:test suites
```

Two deliberate choices:

- **The server is the only authority.** A phone never decides what is legal; it
  renders what the server sent and asks permission for everything else. Each
  player is only ever sent their own hand, so the deal cannot leak through the
  browser console.
- **The rules schema drives the UI.** `SETTINGS_SCHEMA` in `server/rules.js` is the
  single source of truth &mdash; adding a house rule there makes it appear in the
  lobby automatically.

## Known gaps

- No card-passing variant for blind nil (the usual two-card swap with your partner).
- No joker/deuce variants &mdash; standard 52-card deck only.
- Rooms live in one server's memory, so a redeploy ends any game in progress.
- The bot plays competently but will not impress anyone.

## License

MIT. See `LICENSE`.
