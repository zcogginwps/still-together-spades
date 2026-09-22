// House rules. The UI builds its settings screen directly from this schema,
// so adding an option here is all it takes to expose it to the host.

export const SETTINGS_SCHEMA = [
  {
    group: 'Game length',
    items: [
      {
        key: 'targetScore', label: 'Play to', type: 'choice', default: 500,
        options: [200, 300, 500, 750, 1000].map((v) => ({ v, l: String(v) })),
        help: 'First team to reach this score at the end of a hand wins.',
      },
      {
        key: 'minScore', label: 'Mercy rule', type: 'choice', default: -200,
        options: [{ v: null, l: 'Off' }, { v: -200, l: '-200' }, { v: -300, l: '-300' }, { v: -500, l: '-500' }],
        help: 'A team that falls to this score loses immediately. Keeps a blowout short.',
      },
    ],
  },
  {
    group: 'Bidding',
    items: [
      {
        key: 'allowNil', label: 'Allow nil', type: 'bool', default: true,
        help: 'A player can bid zero tricks for a bonus, or a penalty if they take one.',
      },
      {
        key: 'nilValue', label: 'Nil is worth', type: 'choice', default: 100,
        options: [50, 100, 150].map((v) => ({ v, l: String(v) })),
        dependsOn: 'allowNil',
      },
      {
        key: 'allowBlindNil', label: 'Allow blind nil', type: 'bool', default: false,
        help: 'Bid nil before seeing your cards. Everyone bids blind or passes before hands are dealt face up.',
      },
      {
        key: 'blindNilValue', label: 'Blind nil is worth', type: 'choice', default: 200,
        options: [100, 200, 300].map((v) => ({ v, l: String(v) })),
        dependsOn: 'allowBlindNil',
      },
      {
        key: 'blindNilDeficit', label: 'Blind nil only when behind by', type: 'choice', default: 100,
        options: [{ v: 0, l: 'Any time' }, { v: 100, l: '100' }, { v: 150, l: '150' }, { v: 200, l: '200' }],
        dependsOn: 'allowBlindNil',
      },
      {
        key: 'minTeamBid', label: 'Minimum team bid', type: 'choice', default: 0,
        options: [{ v: 0, l: 'None' }, { v: 4, l: '4' }],
        help: 'If on, the second player on a team must bid up so the pair totals at least 4. Nil bidders are exempt.',
      },
    ],
  },
  {
    group: 'Scoring',
    items: [
      {
        key: 'bagsEnabled', label: 'Count bags', type: 'bool', default: true,
        help: 'Overtricks are worth 1 point each but pile up into a penalty.',
      },
      {
        key: 'bagLimit', label: 'Bags before penalty', type: 'choice', default: 10,
        options: [5, 10].map((v) => ({ v, l: String(v) })),
        dependsOn: 'bagsEnabled',
      },
      {
        key: 'bagPenalty', label: 'Bag penalty', type: 'choice', default: 100,
        options: [50, 100, 150].map((v) => ({ v, l: String(v) })),
        dependsOn: 'bagsEnabled',
      },
      {
        key: 'failedNilTricksCountForTeam', label: 'Broken nil helps the team', type: 'bool', default: false,
        help: 'If on, tricks taken by a failed nil bidder count toward the partner’s bid. If off they only become bags.',
      },
      {
        key: 'tenForTwoHundred', label: '10-for-200', type: 'bool', default: false,
        help: 'A team bid of 10 or more scores double if they make it, and double negative if they are set.',
      },
    ],
  },
  {
    group: 'Play',
    items: [
      {
        key: 'spadesBrokenRequired', label: 'Spades must be broken', type: 'bool', default: true,
        help: 'You cannot lead a spade until one has been played, unless spades are all you hold.',
      },
      {
        key: 'trickPauseMs', label: 'Trick stays on screen', type: 'choice', default: 2000,
        options: [{ v: 1200, l: '1.2s' }, { v: 2000, l: '2s' }, { v: 3000, l: '3s' }, { v: 4500, l: '4.5s' }],
        help: 'How long everyone sees the finished trick before it is cleared. Longer is friendlier over a video call.',
      },
    ],
  },
];

export const SETTINGS_ITEMS = SETTINGS_SCHEMA.flatMap((g) => g.items);

export function defaultSettings() {
  const out = {};
  for (const item of SETTINGS_ITEMS) out[item.key] = item.default;
  return out;
}

// Accepts a partial patch from the host and returns a clean, fully populated settings object.
export function sanitizeSettings(patch = {}, base = defaultSettings()) {
  const out = { ...defaultSettings(), ...base };
  for (const item of SETTINGS_ITEMS) {
    if (!(item.key in patch)) continue;
    const value = patch[item.key];
    if (item.type === 'bool') {
      out[item.key] = Boolean(value);
    } else if (item.type === 'choice') {
      if (item.options.some((o) => o.v === value)) out[item.key] = value;
    }
  }
  return out;
}

export const TEAM_OF_SEAT = [0, 1, 0, 1];
export const seatsOfTeam = (team) => (team === 0 ? [0, 2] : [1, 3]);

/**
 * Score one completed hand.
 *
 * @param {object} args
 * @param {Array<{type:'num'|'nil'|'blind', value:number}>} args.bids  indexed by seat
 * @param {number[]} args.tricksWon  indexed by seat
 * @param {number[]} args.bags  current bag count per team
 * @param {object} args.settings
 * @returns {{teams: object[], scoreDelta: number[], bags: number[]}}
 */
export function scoreHand({ bids, tricksWon, bags, settings }) {
  const teams = [];
  const scoreDelta = [0, 0];
  const nextBags = bags.slice();

  for (let team = 0; team < 2; team++) {
    const seats = seatsOfTeam(team);
    const nilSeats = seats.filter((s) => bids[s].type !== 'num');
    const contract = seats
      .filter((s) => bids[s].type === 'num')
      .reduce((sum, s) => sum + bids[s].value, 0);

    // Tricks that count toward the contract.
    const nilTricks = nilSeats.reduce((sum, s) => sum + tricksWon[s], 0);
    const rawTricks = seats.reduce((sum, s) => sum + tricksWon[s], 0);
    const countedTricks = settings.failedNilTricksCountForTeam ? rawTricks : rawTricks - nilTricks;

    // Nil bonuses and penalties are settled independently of the contract.
    let nilPoints = 0;
    const nilResults = [];
    for (const s of nilSeats) {
      const worth = bids[s].type === 'blind' ? settings.blindNilValue : settings.nilValue;
      const made = tricksWon[s] === 0;
      nilPoints += made ? worth : -worth;
      nilResults.push({ seat: s, type: bids[s].type, made, worth });
    }

    let contractPoints = 0;
    let bagsGained = 0;
    const made = countedTricks >= contract;
    const doubled = settings.tenForTwoHundred && contract >= 10;

    if (made) {
      contractPoints = contract * (doubled ? 20 : 10);
      bagsGained = countedTricks - contract;
      // A failed nil's tricks always land in the bag pile when they don't help the contract.
      if (!settings.failedNilTricksCountForTeam) bagsGained += nilTricks;
    } else {
      contractPoints = -contract * (doubled ? 20 : 10);
      // A set team banks nothing: no bag points, and nothing toward the bag penalty.
      bagsGained = 0;
    }

    if (!settings.bagsEnabled) bagsGained = 0;

    let bagPenalty = 0;
    nextBags[team] += bagsGained;
    if (settings.bagsEnabled) {
      while (nextBags[team] >= settings.bagLimit) {
        nextBags[team] -= settings.bagLimit;
        bagPenalty += settings.bagPenalty;
      }
    }

    const total = contractPoints + nilPoints + (settings.bagsEnabled ? bagsGained : 0) - bagPenalty;
    scoreDelta[team] = total;
    teams.push({
      team, contract, tricks: rawTricks, countedTricks, made,
      contractPoints, nilPoints, nilResults, bagsGained, bagPenalty, total, doubled,
    });
  }

  return { teams, scoreDelta, bags: nextBags };
}

/** The lowest number a seat is allowed to bid, honouring the minimum-team-bid rule. */
export function minimumBidFor(seat, bids, settings) {
  if (!settings.minTeamBid) return 0;
  const partner = (seat + 2) % 4;
  const partnerBid = bids[partner];
  if (!partnerBid) return 0;                      // partner hasn't bid yet; no constraint on us
  if (partnerBid.type !== 'num') return 0;        // partner went nil; they carry no share
  return Math.max(0, settings.minTeamBid - partnerBid.value);
}

export function gameWinner(scores, settings) {
  const { targetScore, minScore } = settings;
  if (minScore !== null) {
    const busted = [0, 1].filter((t) => scores[t] <= minScore);
    if (busted.length === 1) return busted[0] === 0 ? 1 : 0;
  }
  const reached = [0, 1].filter((t) => scores[t] >= targetScore);
  if (reached.length === 0) return null;
  if (reached.length === 2) return scores[0] === scores[1] ? null : (scores[0] > scores[1] ? 0 : 1);
  return reached[0];
}
