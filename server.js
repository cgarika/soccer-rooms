/* Table Soccer Rooms — self-hosted multiplayer flick-disc football for two.

   Same shape as the other GameNest game servers (Mini Golf is the model): rooms behind a 6-letter code, the server owns
   the rules, a bot fills the second seat, and a turn that times out is played for you. The server also owns the physics:
   a client sends a disc, an aim and a power, the server simulates the flick (physics.js) and broadcasts every body's
   whole path, which the app plays back. No client decides where anything ends up.

   The contract with the app is PROTOCOL.md (v1); README.md lists what this server adds to it. */

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { PHYS, simulate, compressTail, formation } = require("./physics");
const { createPool, LEVELS } = require("./bots");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Gear = require("./gear");   // the gear table and what it does (gear.js, 2026-11-09)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
/* Heartbeat. socket.io's defaults (25 s + 20 s) notice a dead link only after up to 45 s;
   QA T9 asks for 5 s + 5 s. Opt in with PING_INTERVAL_MS / PING_TIMEOUT_MS. */
const PING = {};
if (Number(process.env.PING_INTERVAL_MS) > 0) PING.pingInterval = Number(process.env.PING_INTERVAL_MS);
if (Number(process.env.PING_TIMEOUT_MS) > 0) PING.pingTimeout = Number(process.env.PING_TIMEOUT_MS);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true }, ...PING });

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 2;
const TURN_MS = Number(process.env.TURN_MS || 15000);
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 6000));
const TIMEOUTS_TO_BOT = 3;
/* Passing (the owner, 2026-10-18: "Pass to a teammate"): a flick in which the ball goes from one of the flicker's discs
   to a different one of theirs, no rival disc touching it between, earns another flick; at most this many in a row. */
const MAX_PASS_BONUS = Math.max(0, Number(process.env.MAX_PASS_BONUS ?? 2));
const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 1200));
const ROOM_IDLE_MS = 2 * 3600e3;
const GOAL_PAUSE_MS = Math.max(0, Number(process.env.GOAL_PAUSE_MS ?? 1300));   // the goal is seen (the app's goal moment is 1.2 s), then the reset; 2600 before soccer r1
/* Playback runs at 60 frames a second; PLAYBACK_SCALE > 1 shortens every wait that is "the time the app takes to play
   the shot" (turn clock, bot delay, goal pause), so a test suite can run fast. */
const PLAYBACK_SCALE = Math.max(0.01, Number(process.env.PLAYBACK_SCALE || 1));
const CLOCK_MS_PER_MINUTE = Math.max(1, Number(process.env.CLOCK_MS_PER_MINUTE || 60000));
const TEST_HOOKS = process.env.TEST_HOOKS === "1";
/* The creeping tail of a flick plays at TAIL_KEEP times the speed (physics.js's compressTail): from the frame after which nothing
   moves faster than TAIL_STILL u/s. TAIL_KEEP=1 plays the whole of it, as before. */
const TAIL_STILL = Math.max(1, Number(process.env.TAIL_STILL || 15));
const TAIL_KEEP = Math.max(1, Math.round(Number(process.env.TAIL_KEEP || 3)));
/* How far back a client may date its flick (`at`, server time). Older or future times are clamped to this window. */
const SHOT_LEEWAY_MS = Math.max(0, Number(process.env.SHOT_LEEWAY_MS ?? 250));
const NAME_GRAPHEMES = 18;             // one cap on every GameNest server, in whole characters
const CAPS = [];                       // nothing to declare yet; `caps` is accepted and stored as golf's is
const GOALS = [1, 2, 3, 5];
const MINUTES = [3, 4, 5];
const PITCHES = ["toybox", "stadium", "rooftop"];

const BOT_NAMES = { easy: "Rookie", normal: "Striker", hard: "Maestro" };
const AVATARS = ["\u{1F60E}", "\u{1F913}", "\u{1F451}", "\u{1F42F}", "\u{1F43C}", "\u{1F98A}"];
const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();
const timers = new Map();
const botTimers = new Map();
const goalPauses = new Map();
const pool = createPool();             // a bot's practice flicks run here (bots.js)

const newId = () => crypto.randomBytes(8).toString("hex");
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }

/* A payload is an object or nothing. `42["create",null]` used to throw inside the
   handler and take the whole process, and every room in it, down. */
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

/* ---------- text ---------- */

/* A string, whatever arrives: a string, a number or a boolean as itself, anything else (an object with a hostile
   toString, an array) as nothing. String() on `{toString: 1}` throws. */
const text = (s) => (typeof s === "string" ? s : typeof s === "number" || typeof s === "boolean" ? String(s) : "");

const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/* At most `max` whole characters (grapheme clusters: an emoji with its skin tone, a flag,
   a letter and its accents) in at most `units` UTF-16 units, never cutting one in half. */
function graphemes(s, max, units) {
  s = text(s);
  if (s.length > 4 * units) s = s.slice(0, 4 * units);    // bounds the work on a 100 KB name
  let out = "", n = 0;
  const parts = SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
  for (const g of parts) {
    if (n >= max || out.length + g.length > units) break;
    out += g; n++;
  }
  return out;
}
const strip = (s) => text(s).replace(/[<>&"'`\u0000-\u001f\u007f]/g, "").trim();
const cleanName = (s) => { const c = graphemes(strip(s), NAME_GRAPHEMES, 96).trim(); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanAvatar = (s) => graphemes(strip(s), 1, 16);
const cleanId = (s) => (typeof s === "string" && s.length > 0 && s.length <= 128 ? s : null);
const cleanCaps = (c) => (Array.isArray(c) ? CAPS.filter((k) => c.includes(k)) : []);

/* A refusal: today's words for today's app, and a code a newer one can switch on without
   reading English. The code rides as a second argument, which an app that reads only the
   first never sees. Codes: not_found, started, full, name, nobody, bad_flick, not_your_disc, not_your_turn. */
function refuse(socket, op, code, message) { socket.emit("err", message, { code, op }); }

/* ---------- chat, voice and push ----------

   Copied from the other room servers rather than reinvented, because a client that already
   speaks them must not find another that is subtly different. */

const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
const cleanChat = (n) => graphemes(text(n).replace(/[<>&"'`]/g, "").trim(), 140, 140);

const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = "Table Soccer";

function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  // only someone who cannot see the screen
  if (!(p.away || !p.connected)) return;
  const now = Date.now();
  if (p._lastPush && now - p._lastPush < 4000) return;
  p._lastPush = now;
  fetch(PUSH_URL + "/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }),
  }).catch(() => {});
}

/* Fires on a change of situation, not on every broadcast: a flick animating for
   four seconds must not send four notifications. */
function pushTurn(room) {
  const key = room.status + "|" + room.turn + "|" + (room.pause ? 1 : 0);
  if (room._pushKey === key) return;
  room._pushKey = key;
  if (room.status !== "playing" || room.pause) return;
  const p = room.players[room.turn];
  if (!p) return;
  pushTo(p, "Your turn in " + PUSH_TITLE + ", room " + room.code,
    { code: room.code, game: PUSH_TITLE }, room.code + "-turn");
}

/* ---------- room shape ---------- */

function newRoom(code, host) {
  return {
    v: 1, code, host, status: "lobby",
    players: [],
    opts: { goals: 3, minutes: 4, pitch: "toybox" },      // the host's choices
    bodies: formation(0),          // 10 discs then the ball, [x, y] each
    turn: 0,
    kickoff: true,                 // the next flick is a kick-off flick
    score: [0, 0],
    clockEndsAt: null,
    golden: false,
    pause: false,                  // a goal is being shown; nobody may flick
    goalPauseEndsAt: null,
    lastShot: null,
    mv: 0,                         // flicks played this match
    winner: null,
    log: "Share the code with your friend.",
    chat: [],
    turnEndsAt: null,
    gearOn: true,                  // the host's "gear" switch (private rooms); quick and ranked rooms always play with gear
    playUntil: 0,                  // server ms the app is busy playing the last flick back until
    round: 0,                      // counts matches, so a bot's late answer cannot cross one
    touched: Date.now(),
  };
}

/* ---------- gear (gear.js) ---------- */
/* What a seat's gear does at this table: its stats when the room's gear switch is on, nothing (the base values) when it is off or the player sent none. A bot, and a person a bot plays for,
   plays on the base physics (it plans its flicks on them): its gear is the look it wears and the score it shows, never an advantage. */
const NO_GEAR = Gear.soccerEffects(null);
const gearStats = (room, p) => (room.gearOn !== false && p && p.gear ? p.gear.stats : null);
const gearFx = (room, p) => (p && !p.bot && !p.botControlled && !p.left ? Gear.soccerEffects(gearStats(room, p)) : NO_GEAR);
const gearView = (room, p) => (p && p.gear ? { score: p.gear.score, items: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.item])), levels: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.level])), stats: room.gearOn !== false ? p.gear.stats : { power: 0, aim: 0, reach: 0, shot: 0 }, fx: { reach: gearFx(room, p).reach } } : null);
/* The bots' gear fits the humans' band: the mean of the humans' gear scores (a human with none counts as the starter set), and none at all when no human sent any (old apps: everyone at the base).
   Set when a match starts, so a rematch follows who is there now. */
function gearBots(room) {
  const hs = room.players.filter((p) => !p.bot && !p.left);
  const sent = hs.filter((p) => p.gear);
  for (const p of room.players) if (p.bot) p.gear = null;
  if (!sent.length) return;
  const score = Math.round(hs.reduce((n, p) => n + Gear.scoreFor(p.gear, "soccer"), 0) / hs.length);
  for (const p of room.players) if (p.bot) p.gear = Gear.botGear("soccer", score);
}

function activeSeats(room) { return room.players.map((p, i) => i).filter((i) => !room.players[i].left); }

const PITCH = { w: PHYS.W, l: PHYS.L, goalX: [PHYS.GOAL_X0, PHYS.GOAL_X1], goalDepth: PHYS.GOAL_DEPTH, discR: PHYS.DISC_R, ballR: PHYS.BALL_R, postR: PHYS.POST_R };

/* A bot's turn as the players watch it (soccer r1, S6): once its shot is thought out (off the event loop, during the last flick's playback) the state says which
   disc it will flick, the aim and the power, when the app's playback of the last flick is over (from: the pull starts there) and when the flick lands (at). The app rings
   the disc, grows its aim arrow from nothing to the power between the two, and says "Striker is aiming...". The flick itself is the same one, at the same time. */
function thinkingView(room) {
  const plan = room.botPlan;
  if (!plan || !plan.shot || room.status !== "playing" || room.pause) return null;
  const sh = plan.shot;
  return { seat: room.turn, disc: sh.disc, aim: Math.round(sh.aim * 1000) / 1000, power: Math.round(sh.power * 1000) / 1000, from: Math.min(plan.at, Math.max(room.playUntil || 0, plan.t0 || 0)), at: plan.at };
}

function publicRoom(room) {
  return {
    code: room.code, status: room.status,
    players: room.players.map((p) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, ...(p.bot ? { level: p.level } : {}),
      botControlled: !!p.botControlled, left: p.left, connected: p.connected, gear: gearView(room, p),
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    gearOn: room.gearOn !== false,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    opts: { goals: room.opts.goals, minutes: room.opts.minutes, pitch: room.opts.pitch },
    pitch: PITCH,
    bodies: room.bodies,
    turn: room.turn, kickoff: room.kickoff, score: room.score,
    clockEndsAt: room.clockEndsAt, golden: room.golden,
    turnEndsAt: room.turnEndsAt, winner: room.winner,
    lastShot: room.lastShot,
    log: room.log, chat: room.chat, voice: room.voice ? Array.from(room.voice) : [],
    // additive, for newer apps
    serverNow: Date.now(),
    goalPauseEndsAt: room.goalPauseEndsAt,
    thinking: thinkingView(room),     // soccer r1: a bot's turn as the players see it (the disc it picked, its pull, when it flicks), null otherwise
    passRun: room.passRun || 0,     // bonus flicks earned by passes in a row this turn (0 to MAX_PASS_BONUS)
    maxPassBonus: MAX_PASS_BONUS,
    v: room.v,
    ...Reactions.view(room),   // 2026-10-15: reactionsOn and the last reactions
    ...Quick.view(room),   // quick play and ranked (2026-10-24)
  };
}

/* ---------- the waiting line (the owner, 2026-09-29) ----------
   Someone who joins a match already under way (and whose app says "waitList") waits in line,
   watching. A seat someone leaves mid-match goes to the first in line at once (the score stands: they play on
   for that side); the rest are seated at the rematch. */
function takeLeftSeats(room) {
  if (!room.waiting || !room.waiting.length || room.status !== "playing") return false;
  let seated = false;
  for (let seat = 0; seat < room.players.length && room.waiting.length; seat++) {
    const old = room.players[seat];
    if (!old.left) continue;
    const w = room.waiting.shift();
    room.players[seat] = Object.assign({}, old, { id: w.id, name: w.name, avatar: w.avatar, bot: false, botControlled: false,
      left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, caps: w.caps, gear: w.gear || null, timeouts: 0 });
    room.log = `${w.name} took ${old.name}'s seat.`;
    if (room.host === old.id) room.host = w.id;
    seated = true;
  }
  return seated;
}
function seatTheLine(room) {
  while (room.waiting && room.waiting.length) {
    if (room.players.length >= MAX_PLAYERS) break;
    const w = room.waiting.shift();
    room.players.push({ id: w.id, name: w.name, avatar: w.avatar, left: false, connected: true, caps: w.caps, plus: w.plus, acct: w.acct, look: w.look, gear: w.gear || null });
  }
}
function lineState(room, st, playerId, seat) {
  st.waiting = (room.waiting || []).map((w) => ({ name: w.name, avatar: w.avatar }));
  st.waitPos = seat < 0 ? (room.waiting || []).findIndex((w) => w.id === playerId) + 1 : 0;
  return st;
}

function sendState(code) {
  const room = rooms.get(code), sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  try { pushTurn(room); } catch (_) {}
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: lineState(room, Object.assign({}, pub), s.data.playerId, mySeat), mySeat });
  }
}
function bump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }

/* ---------- play ---------- */

const r2 = (v) => Math.round(v * 100) / 100;
const playbackMs = (shot) => Math.round(((shot.frames && shot.frames.length) || 0) * 1000 / 60 / PLAYBACK_SCALE);
const clockOver = (room) => room.clockEndsAt != null && Date.now() >= room.clockEndsAt;

/* Kick-off: the formation, the side that kicks stepped up, and it is that side's turn. */
function setKickoff(room, kickSeat) {
  room.bodies = formation(kickSeat);
  room.kickoff = true;
  room.turn = kickSeat;
  room.passRun = 0;
  room.pause = false;
  room.goalPauseEndsAt = null;
  room.playUntil = 0;
}

function startMatch(room) {
  room.status = "playing";
  room.round = (room.round || 0) + 1;
  room.score = [0, 0];
  room.golden = false;
  room.winner = null;
  room.lastShot = null;
  room.mv = 0;
  room.clockEndsAt = Date.now() + room.opts.minutes * CLOCK_MS_PER_MINUTE;
  gearBots(room);
  setKickoff(room, (room.round - 1) % 2);
  room.log = `Kick-off! First to ${room.opts.goals}, or the most goals in ${room.opts.minutes} minutes.`;
}

function finishMatch(room, winner, log) {
  room.status = "over";
  room.winner = winner;
  room.pause = false;
  room.goalPauseEndsAt = null;
  room.turnEndsAt = null;
  clearT(timers, room.code); clearT(botTimers, room.code); clearT(goalPauses, room.code);
  room.botPlan = null;
  room.log = log;
}

/* Does the match end now? `scorer` is the seat that just scored, or null at the end of a flick without a goal. */
function checkEnd(room, scorer) {
  const [a, b] = room.score;
  const name = (s) => room.players[s].name;
  if (a >= room.opts.goals || b >= room.opts.goals) {
    const w = a > b ? 0 : 1;
    return finishMatch(room, w, `${name(w)} wins it, ${room.score[w]}-${room.score[1 - w]}!`), true;
  }
  if (room.golden && scorer != null) {
    return finishMatch(room, scorer, `${name(scorer)} scores the golden goal and wins it, ${room.score[scorer]}-${room.score[1 - scorer]}!`), true;
  }
  if (!room.golden && clockOver(room)) {
    if (a !== b) {
      const w = a > b ? 0 : 1;
      return finishMatch(room, w, `Full time: ${name(w)} wins, ${room.score[w]}-${room.score[1 - w]}!`), true;
    }
    room.golden = true;
    room.log = `Full time, ${a}-${b}. Golden goal: the next one wins it!`;
  }
  return false;
}

/* A pass in a flick's moments: the ball kicked by one of `seat`'s discs, then by a different one of theirs, with no
   rival disc kicking it between. Returns { from, to, f } (f: the receiving touch's frame), or null. */
function findPass(events, seat) {
  const mine = (d) => d >= seat * 5 && d < seat * 5 + 5;
  let last = null;
  for (const e of events || []) {
    if (e.k !== "kick") continue;
    if (last != null && mine(last) && mine(e.a) && e.a !== last) return { from: last, to: e.a, f: e.f };
    last = e.a;
  }
  return null;
}

/* The one place a flick happens. Returns false if it was not this seat's to play. */
function playFlick(room, seat, disc, aim, power, at) {
  if (room.status !== "playing" || room.turn !== seat || room.pause) return false;
  if (!(disc >= seat * 5 && disc < seat * 5 + 5)) return false;
  const pw = Math.min(1, Math.max(0, power));
  /* The flicker's gear: the flick's top speed (power). Each seat's keeper (discs 0 and 5) has the radius its own gear (reach) gives it, whoever flicks. */
  const fx = gearFx(room, room.players[seat]);
  const keepers = [gearFx(room, room.players[0]).reach, gearFx(room, room.players[1]).reach];
  const gearOpts = fx.speed !== 1 || keepers[0] !== 1 || keepers[1] !== 1 ? { speed: fx.speed, keepers } : undefined;
  const sim = simulate(room.bodies, disc, aim, pw, gearOpts);
  const shot = TAIL_KEEP > 1 ? compressTail(sim, TAIL_STILL, TAIL_KEEP) : sim;
  room.mv++;
  room.kickoff = false;
  room.bodies = shot.end;
  const when = at != null ? at : Date.now();
  room.lastShot = { seat, disc, aim, power: pw, mv: room.mv, at: when, frames: shot.frames, events: shot.events, result: shot.result };
  if (shot.goalFor != null) room.lastShot.goalFor = shot.goalFor;
  const ms = playbackMs(shot);
  room.playUntil = Date.now() + ms;
  const name = room.players[seat].name;

  if (shot.result === "goal") {
    const gf = shot.goalFor;
    room.score[gf]++;
    room.log = gf === seat ? `GOAL! ${name} scores, ${room.score[0]}-${room.score[1]}.` : `Own goal! ${name} puts it in their own net, ${room.score[0]}-${room.score[1]}.`;
    const ended = checkEnd(room, gf);
    Reactions.event(room, gf, ended ? "win" : "good", bump, ms + 1500);
    Reactions.event(room, 1 - gf, "bad", bump, ms + 1500);
    if (!ended) {
      room.pause = true;
      room.turnEndsAt = null;
      room.goalPauseEndsAt = Date.now() + ms + GOAL_PAUSE_MS;
    }
  } else {
    const pass = findPass(shot.events, seat);
    if (pass && (room.passRun || 0) < MAX_PASS_BONUS && !clockOver(room)) {
      // A pass: the same side flicks again. The moment rides in the shot's events at the receiving touch.
      room.passRun = (room.passRun || 0) + 1;
      room.lastShot.pass = pass;
      room.lastShot.events = shot.events.concat([{ f: pass.f, k: "pass", a: pass.from, b: pass.to, s: 1 }]).sort((x, y) => x.f - y.f);
      room.log = `Pass! ${name} flicks again.`;
    } else {
      room.passRun = 0;
      room.log = shot.result === "timeout" ? `${name} flicks; it takes a while to settle.` : `${name} flicks.`;
      room.turn = 1 - seat;
      checkEnd(room, null);
    }
  }
  return true;
}

/* Arm the next turn's clock (or the goal pause), then broadcast. The clock is armed BEFORE the broadcast on every
   path: a state must carry the deadline of the turn it shows. */
function afterFlick(room) {
  if (room.status !== "playing") { bump(room); return; }
  if (room.pause) {
    clearT(timers, room.code); clearT(botTimers, room.code); clearT(goalPauses, room.code);
    room.botPlan = null;
    room.turnEndsAt = null;
    bump(room);
    const code = room.code, round = room.round;
    goalPauses.set(code, setTimeout(() => {
      goalPauses.delete(code);
      const r = rooms.get(code);
      if (!r || r.round !== round || r.status !== "playing" || !r.pause) return;
      const conceded = 1 - r.lastShot.goalFor;
      setKickoff(r, conceded);
      r.log = `${r.players[conceded].name} kicks off.`;
      armTimer(code);
      bump(r);
    }, Math.max(0, room.goalPauseEndsAt - Date.now())));
    return;
  }
  armTimer(room.code);
  bump(room);
}

/* ---------- timers and bots ---------- */

/* What a bot's answer was worked out for. Anything that changes whose flick it is, or
   from where, changes this, and an answer for an old key is thrown away. */
function turnKey(room) {
  return `${room.round}|${room.status}|${room.mv}|${room.turn}|${room.pause ? 1 : 0}|${room.kickoff ? 1 : 0}`;
}

/* Ask the pool which flick a bot would play for the seat whose turn it is. */
function think(room, level) {
  return pool.think({ bodies: room.bodies, seat: room.turn, level });
}

function armTimer(code) {
  const room = rooms.get(code);
  clearT(timers, code);
  scheduleBot(code);
  if (!room || room.status !== "playing" || room.pause) { if (room) room.turnEndsAt = null; return; }
  const cur = room.players[room.turn];
  const ms = cur && !cur.bot && !cur.botControlled && !cur.connected ? AFK_MS : TURN_MS + (cur && !cur.bot && !cur.botControlled && !cur.left ? gearFx(room, cur).shotMs : 0);   // the boots add seconds to a person's flick clock
  const now = Date.now();
  const from = Math.max(now, room.playUntil || 0);   // the last flick's playback is on the clock's side, not the player's
  room.turnEndsAt = from + ms;
  timers.set(code, setTimeout(() => onTimeout(code), room.turnEndsAt - now));
}

function onTimeout(code) {
  timers.delete(code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing" || room.pause) return;
  const p = room.players[room.turn];
  if (!p) return;
  let note = "";
  if (!p.bot && !p.botControlled) {
    p.timeouts = (p.timeouts || 0) + 1;
    if (p.timeouts >= TIMEOUTS_TO_BOT) { p.botControlled = true; note = `A bot is playing for ${p.name}.`; }
    else note = `${p.name} ran out of time; the flick was played for them.`;
  }
  const seat = room.turn, key = turnKey(room), at = Date.now();
  think(room, "easy").then((f) => {
    const r = rooms.get(code);
    if (!r || turnKey(r) !== key) return;         // someone flicked meanwhile
    if (!playFlick(r, seat, f.disc, f.aim, f.power, at)) return;
    if (note) r.log = `${note} ${r.log}`;
    afterFlick(r);
  });
}

/* How long a bot of this level "thinks", ms, before BOT_MS scales it (1200 is the default). Pacing round 1 (2026-11-01): the
   phone's log had the normal bot take 3.7 s a flick at the median (the human's flick played back, then 1.0-1.6 s of thought),
   and its pass-bonus flicks the same again. Now the thought follows the shot: from the low end of the level's range for a
   short flick (the disc is close to the ball) to the high end for a long one, a little random on top; a flick that is a pass
   bonus (the bot is still in the same move) comes at 0.55 of that; and the tail of every playback is thinned (physics.js,
   compressTail), so the whole wait between a person's flick and the bot's is about 2.4 s at the median. The shot is thought out
   off the event loop from the moment the turn passes, so it is ready when the playback is over. */
const THINK = { easy: [650, 1150], normal: [850, 1400], hard: [800, 1600] };
const THINK_MAX_MS = 1800;
function thinkMsFor(room, level, shot, chained) {
  const [lo, hi] = THINK[level] || THINK.normal;
  let u = 0.5;
  try {
    const ball = room.bodies[PHYS_BALL], d = room.bodies[shot.disc];
    u = Math.min(1, 0.75 * Math.min(1, Math.hypot(ball[0] - d[0], ball[1] - d[1]) / 55) + 0.25 * crypto.randomInt(1000) / 1000);
  } catch (e) { u = crypto.randomInt(1000) / 1000; }
  let ms = lo + (hi - lo) * u;
  if (chained) ms *= 0.55;
  return Math.max(1, Math.round(Math.min(THINK_MAX_MS, ms) * BOT_MS / 1200));
}
const PHYS_BALL = 10;

/* A bot's flick: its thinking starts now, off the event loop, and the flick lands when its think time is up (and the
   last flick has been played back). */
function scheduleBot(code) {
  clearT(botTimers, code);
  const room = rooms.get(code);
  if (!room) return;
  room.botPlan = null;
  if (room.status !== "playing" || room.pause) return;
  const p = room.players[room.turn];
  if (!p || !(p.bot || p.botControlled)) return;
  const level = p.bot ? p.level : "normal";
  const now = Date.now();
  const chained = (room.passRun || 0) > 0;
  const [lo, hi] = THINK[level] || THINK.normal;
  // Until the shot is known (and with it how hard it is) the middle of the level's range is the guess.
  const delay = Math.max(0, (room.playUntil || 0) - now) + ((lo + hi) / 2) * (chained ? 0.55 : 1) * BOT_MS / 1200;
  const plan = { key: turnKey(room), at: now + delay, shot: null, due: false, t0: now };
  room.botPlan = plan;
  const fireIn = (ms) => {
    clearT(botTimers, code);
    botTimers.set(code, setTimeout(() => {
      botTimers.delete(code);
      plan.due = true;
      if (plan.shot) playPlan(code, plan);
    }, Math.max(0, ms)));
  };
  think(room, level).then((shot) => {
    plan.shot = shot;
    const r = rooms.get(code);
    if (!r || r.botPlan !== plan) return;
    if (plan.due) return playPlan(code, plan);   // the nominal time passed while the pool was thinking: no more waiting
    // The thought is as long as the shot is hard, counted from the end of the playback in progress.
    const t = Date.now();
    plan.at = Math.max(r.playUntil || 0, t) + thinkMsFor(r, level, shot, chained);
    if (plan.at <= t) { plan.due = true; return playPlan(code, plan); }
    fireIn(plan.at - t);
    bump(r);   // the state now says which disc the bot has picked and when it flicks (thinking)
  }, () => {});
  fireIn(delay);
}

function playPlan(code, plan) {
  const r = rooms.get(code);
  if (!r || r.botPlan !== plan) return;
  r.botPlan = null;
  if (r.status !== "playing" || turnKey(r) !== plan.key) return;
  const cur = r.players[r.turn];
  if (!cur || !(cur.bot || cur.botControlled)) return;
  if (!playFlick(r, r.turn, plan.shot.disc, plan.shot.aim, plan.shot.power, plan.at)) return;
  afterFlick(r);
}

function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back${reason ? " (" + reason + ")" : ""}.`;
  if (room.status === "playing" && room.players[room.turn] === p) { clearT(botTimers, room.code); room.botPlan = null; armTimer(room.code); }
  return true;
}

function addBotTo(room, level) {
  if (room.players.length >= MAX_PLAYERS) return null;
  level = LEVELS.includes(level) ? level : "normal";
  const used = room.players.map((q) => q.name);
  const name = !used.includes(BOT_NAMES[level]) ? BOT_NAMES[level] : "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, level, left: false, connected: true };
  room.players.push(p);
  return p;
}

/* ---------- sockets ---------- */

/* Seat a socket in a room. A socket already listening to another room leaves it first,
   and its seat there goes dark, exactly as if it had disconnected: one socket, one room. */
function attach(socket, code, playerId) {
  const was = socket.data.roomCode;
  if (was && (was !== code || socket.data.playerId !== playerId)) dropFromRoom(socket);
  socket.data.playerId = playerId;
  socket.data.roomCode = code;
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}
function detach(socket) {
  const code = socket.data.roomCode;
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (!set.size) roomSockets.delete(code); }
  socket.data.roomCode = null;
}
/* Is this player still here on another socket (a reconnect that beat the old socket's
   timeout)? Then the old socket going says nothing about them. */
function heldElsewhere(room, id) {
  const set = roomSockets.get(room.code);
  if (set) for (const s of set) if (s.data.playerId === id) return true;
  return false;
}
function dropFromRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  const p = room ? room.players.find((q) => q.id === socket.data.playerId) : null;
  const id = socket.data.playerId;
  detach(socket);
  // A watcher in the waiting line who goes away leaves the line (they can join again).
  if (room && !p && room.waiting && room.waiting.some((w) => w.id === id)) { room.waiting = room.waiting.filter((w) => w.id !== id); bump(room); return; }
  if (!room || !p || heldElsewhere(room, p.id)) return;
  p.connected = false;
  if (room.status === "playing" && room.players[room.turn] === p && !room.pause) armTimer(room.code);
  bump(room);
}

function forgetRoom(room) {
  rooms.delete(room.code);
  clearT(timers, room.code); clearT(botTimers, room.code); clearT(goalPauses, room.code);
}

Quick.init({ game: 'soccer', model: 'glicko', seats: 2, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState,
  /* Quick and ranked play match within gear-score bands (gear.js BAND): an open room takes a player whose gear score is within it of the host's. Nothing on screen says so. */
  accept: (room, payload) => { const host = room.players.find((p) => p.id === room.host); return Gear.bandOk(Gear.scoreFor(host && host.gear, "soccer"), Gear.scoreFor(Gear.clean("soccer", payload.gear), "soccer")); } });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
  Quick.hook(socket); Quick.connection(socket);   // before the server's own events
  const currentRoom = () => rooms.get(socket.data.roomCode);
  Reactions.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId,
    isHost: (r) => r.host === socket.data.playerId, bump });
  const me = () => { const r = currentRoom(); return r ? r.players.find((p) => p.id === socket.data.playerId) : null; };

  socket.on("create", (payload) => {
    const { name: rawName, playerId, avatar, caps, plus, look, crew, gear } = obj(payload);
    const name = cleanName(rawName);
    if (!name) return refuse(socket, "create", "name", "Pick a name first.");
    let code = genCode(); let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);   // GameNest Plus's crew code (2026-10-17)
    const id = cleanId(playerId) || newId();
    const room = newRoom(code, id);
    room.players.push({ id, name, avatar: cleanAvatar(avatar) || AVATARS[0], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("soccer", gear) });
    rooms.set(code, room);
    attach(socket, code, id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: id });
    bump(room);
  });

  socket.on("join", (payload) => {
    const { code: rawCode, name, playerId, avatar, caps, plus, look, gear } = obj(payload);
    const code = text(rawCode).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "join", "not_found", "No room with that code.");
    const known = cleanId(playerId);
    let p = known ? room.players.find((q) => q.id === known) : null;
    if (p) {
      p.connected = true; p.left = false;
      p.caps = cleanCaps(caps);
      if (gear !== undefined && room.status === "lobby") p.gear = Gear.clean("soccer", gear);   // gear changes between matches, never in one
      humanIsBack(room, p, "reconnected");
      const n = cleanName(name);
      if (n) p.name = n;
    } else {
      if (room.status !== "lobby") {
        // A match under way: an app that knows the line waits in it; an older one hears the match has started.
        const capList = Array.isArray(caps) ? caps : [];
        if (!capList.includes("waitList")) return refuse(socket, "join", "started", "That match already started.");
        const n = cleanName(name);
        if (!n) return refuse(socket, "join", "name", "Pick a name first.");
        const id = known || newId();
        room.waiting = room.waiting || [];
        if (!room.waiting.some((q) => q.id === id)) {
          if (room.waiting.length >= 6) return refuse(socket, "join", "full", "Room is full.");
          room.waiting.push({ id, name: n, avatar: cleanAvatar(avatar) || AVATARS[0], caps: cleanCaps(caps), plus: plus === true, acct: Plus.acctOf(socket), look: Plus.cleanLook(look), gear: Gear.clean("soccer", gear) });
          room.log = `${n} is waiting for a seat.`;
        }
        attach(socket, code, id);
        socket.emit("joined", { code, playerId: id, waiting: true });
        if (takeLeftSeats(room)) armTimer(room.code);
        bump(room);
        return;
      }
      if (room.players.length >= MAX_PLAYERS) return refuse(socket, "join", "full", `Room is full (${MAX_PLAYERS}).`);
      const n = cleanName(name);
      if (!n) return refuse(socket, "join", "name", "Pick a name first.");
      const id = known || newId();
      p = { id, name: n, avatar: cleanAvatar(avatar) || AVATARS[room.players.length % AVATARS.length], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("soccer", gear) };
      room.players.push(p);
      room.log = `${n} joined.`;
    }
    attach(socket, code, p.id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: p.id });
    bump(room);
  });

  /* The host's choices, in the lobby or between matches: { goals: 1|2|3|5, minutes: 3|4|5, pitch: "toybox"|"stadium"|"rooftop", gear: boolean } (gear is the host's gear switch, private rooms only). */
  socket.on("settings", (payload) => {
    const { goals, minutes, pitch, gear } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    let changed = false;
    if (typeof gear === "boolean" && !room.quick && gear !== (room.gearOn !== false)) { room.gearOn = gear; room.log = gear ? "Gear is on." : "Gear is off: everyone plays at the base."; bump(room); }
    if (GOALS.includes(goals) && goals !== room.opts.goals) { room.opts.goals = goals; changed = true; }
    if (MINUTES.includes(minutes) && minutes !== room.opts.minutes) { room.opts.minutes = minutes; changed = true; }
    if (PITCHES.includes(pitch) && pitch !== room.opts.pitch) { room.opts.pitch = pitch; changed = true; }
    if (changed) { room.log = `First to ${room.opts.goals}, ${room.opts.minutes} minutes, ${room.opts.pitch} pitch.`; bump(room); }
  });

  /* A player's gear changed while they sat in the lobby (they upgraded or bought something on the gear page): { discs: { item, level }, keeper, boots }. Clamped as on join. */
  socket.on("gear", (payload) => {
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "lobby") return;
    self.gear = Gear.clean("soccer", obj(payload));
    room.log = `${self.name} changed their gear.`;
    bump(room);
  });

  socket.on("addBot", (payload) => {
    const { level } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "addBot", "full", "Room is full.");
    const b = addBotTo(room, level);
    if (!b) return;
    room.log = `${b.name} (${b.level} bot) joined.`;
    bump(room);
  });

  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) { room.log = `${room.players[i].name} left.`; room.players.splice(i, 1); break; }
    }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS) return refuse(socket, "start", "nobody", "Nobody to play against.");
    startMatch(room);
    armTimer(room.code);
    bump(room);
  });

  /* A flick: { disc: 0-9 (one of your own), aim: radians in the absolute frame, power: 0..1, at? }. */
  socket.on("flick", (payload) => {
    const { disc, aim, power, at } = obj(payload);
    const room = currentRoom();
    const self = me();
    if (!room || !self || room.status !== "playing") return;
    const seat = room.players.indexOf(self);
    if (seat !== room.turn || room.pause) return refuse(socket, "flick", "not_your_turn", "Not your turn.");
    if (!Number.isInteger(disc) || disc < 0 || disc > 9 || !Number.isFinite(aim) || !Number.isFinite(power)) return refuse(socket, "flick", "bad_flick", "Bad flick.");
    if (disc < seat * 5 || disc >= seat * 5 + 5) return refuse(socket, "flick", "not_your_disc", "That is not your disc.");
    if (humanIsBack(room, self, "took the flick")) clearT(botTimers, room.code);
    const now = Date.now();
    const when = Number.isFinite(at) ? Math.min(now, Math.max(now - SHOT_LEEWAY_MS, at)) : now;
    if (!playFlick(room, seat, disc, aim, power, when)) return;
    afterFlick(room);
  });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    const here = room.players.filter((q) => !q.left).length + Math.max(0, (room.waiting || []).length);
    if (here < MIN_PLAYERS) return refuse(socket, "rematch", "nobody", "Nobody to play against.");
    // Those who left give their seats up now, and the waiting line sits down.
    room.players = room.players.filter((q) => !q.left);
    seatTheLine(room);
    if (!room.players.some((q) => q.id === room.host)) room.host = room.players.find((q) => !q.bot).id;
    startMatch(room);
    room.log = `Rematch! ${room.log}`;
    armTimer(room.code);
    bump(room);
  });

  socket.on("takeSeat", () => {
    const room = currentRoom(), p = me();
    if (room && p && humanIsBack(room, p, "took the seat back")) bump(room);
  });

  function handleLeave() {
    const room = currentRoom(), p = me();
    const id = socket.data.playerId;
    detach(socket);
    if (room && !p && room.waiting && room.waiting.some((w) => w.id === id)) {
      // Out of the waiting line.
      room.waiting = room.waiting.filter((w) => w.id !== id);
      bump(room);
      return;
    }
    if (!room || !p) return;
    room.log = `${p.name} left.`;
    if (room.status === "lobby") {
      // Nobody sits in a seat that has gone: in the lobby a leaver just leaves, and the host passes to the next human.
      room.players = room.players.filter((q) => q !== p);
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot); if (h) room.host = h.id; }
    } else {
      p.left = true; p.connected = false;
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot && !q.left); if (h) room.host = h.id; }
      if (room.status === "playing") {
        const seat = room.players.indexOf(p);
        if (room.waiting && room.waiting.length) {
          // The first in line takes the seat and plays on for that side.
          takeLeftSeats(room);
        } else {
          const other = room.players[1 - seat];
          if (other && !other.bot && !other.left) {
            finishMatch(room, 1 - seat, `${p.name} left. ${other.name} wins!`);
            Reactions.event(room, 1 - seat, "win", bump, 0);
          }
        }
      }
    }
    if (room.players.every((q) => q.left || q.bot)) { forgetRoom(room); return; }
    if (room.status === "playing" && !room.pause) armTimer(room.code);
    bump(room);
  }

  socket.on("pushToken", (payload) => {
    const { token } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token;
  });

  socket.on("presence", (payload) => {
    const { away } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) p.away = !!away;
  });

  socket.on("chat", (payload) => {
    let { text, sticker } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;

    let msg = null;
    if (sticker) {
      if (!STICKERS.includes(sticker)) return;
      msg = { k: "s", s: sticker };
    } else {
      text = cleanChat(text);
      if (!text) return;
      msg = { k: "t", x: text };
    }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
      room.chat.push(msg);
      // a sticker is not worth waking someone for; words are
      if (msg.k === "t") {
        for (const q of room.players) {
          if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
        }
      }
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      room.touched = Date.now();
      bump(room);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  /* Voice is peer to peer; the server only carries the handshake, never audio.
     The 20k ceiling is what stops a signal being used as a data channel. */
  socket.on("voice", (payload) => {
    const { kind, to, data } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;

    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat);
      else room.voice.delete(seat);
      room.touched = Date.now();
      bump(room);
      return;
    }

    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const sockets = roomSockets.get(room.code);
      if (!sockets) return;
      for (const s of sockets) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  /* Tests only (TEST_HOOKS=1): put the match where a test needs it. { bodies: 11 [x,y], score: [a,b], clockMs: ms from
     now until full time (may be negative), golden, turn, kickoff, botControlled: [bool, bool] }. */
  if (TEST_HOOKS) socket.on("testSet", (payload) => {
    const o = obj(payload);
    const room = currentRoom();
    if (!room || !me()) return;
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    if (Array.isArray(o.bodies) && o.bodies.length === 11 && o.bodies.every((b) => Array.isArray(b) && num(b[0]) && num(b[1]))) room.bodies = o.bodies.map((b) => [r2(b[0]), r2(b[1])]);
    if (Array.isArray(o.score) && o.score.length === 2 && o.score.every((s) => Number.isInteger(s) && s >= 0)) room.score = o.score.slice();
    if (num(o.clockMs)) room.clockEndsAt = Date.now() + o.clockMs;
    if (typeof o.golden === "boolean") room.golden = o.golden;
    if (o.turn === 0 || o.turn === 1) room.turn = o.turn;
    if (typeof o.kickoff === "boolean") room.kickoff = o.kickoff;
    if (Array.isArray(o.botControlled)) o.botControlled.slice(0, 2).forEach((b, i) => { if (room.players[i] && !room.players[i].bot) room.players[i].botControlled = !!b; });
    if (room.status === "playing" && !room.pause) armTimer(room.code);
    bump(room);
  });

  socket.on("leave", handleLeave);
  socket.on("disconnect", () => dropFromRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) forgetRoom(room);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Table Soccer Rooms running on port ${PORT}${BASE ? " under " + BASE : ""}`));

module.exports = { app, server, io, pool, thinkMsFor };
