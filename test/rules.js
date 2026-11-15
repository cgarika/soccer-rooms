/* Table Soccer — rooms and rules over real sockets.
   Run: node test/run.js  (starts the servers). By hand:
     TEST_HOOKS=1 PORT=3641 BOT_MS=5 GOAL_PAUSE_MS=400 PLAYBACK_SCALE=20 node server.js
     TEST_HOOKS=1 PORT=3642 BOT_MS=5 GOAL_PAUSE_MS=100 PLAYBACK_SCALE=20 TURN_MS=1500 AFK_MS=300 node server.js
     URL=http://localhost:3641 URL_TURN=http://localhost:3642 node test/rules.js

   Proves: a room forms (create / join / full / not_found / name), the host's settings, bots (addBot / removeBot / start),
   the state's shape; out-of-turn and wrong-disc and bad-flick refusals (with their codes); a flick's shot (frames,
   events, bodies, the turn passing); a goal -> the pause (nobody may flick) -> the reset, the side that conceded to kick
   off; first to opts.goals ends the match; the clock, full time and the golden goal; the turn timeout's auto-flick, three
   in a row handing the seat to a bot, and a disconnected player's short clock; rematch; leave and disconnect; hostile
   payloads; one socket one room; names; chat, voice and presence; and a whole match between two bots. */

"use strict";
const { io } = require("socket.io-client");
const { formation } = require("../physics");
const URL = process.env.URL || "http://localhost:3641";
const URL_TURN = process.env.URL_TURN || "http://localhost:3642";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0, checks = 0;
const check = (ok, what, extra) => { checks++; if (!ok) { failures++; console.log("  FAIL: " + what + (extra ? "  " + extra : "")); } };
const section = (n) => console.log("\n" + n);

const uid = () => "t" + Math.random().toString(36).slice(2, 10);
function mk(url, name) {
  const s = io(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.nm = name; s.st = null; s.seat = -1; s.errs = []; s.joined = null; s.pid = uid(); s.hist = [];
  s.on("state", ({ room, mySeat }) => { s.st = room; s.seat = mySeat; s.hist.push(room); });
  s.on("err", (msg, detail) => s.errs.push({ msg, detail }));
  s.on("joined", (j) => { s.joined = j; });
  return s;
}
const connected = async (s) => { for (let i = 0; i < 300 && !s.connected; i++) await sleep(10); };
const waitFor = async (s, pred, ms = 6000, what = "state") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (s.st && pred(s.st)) return true; await sleep(10); }
  check(false, `timed out waiting for ${what}`);
  return false;
};
const waitErr = async (s, n, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && s.errs.length < n) await sleep(10); return s.errs[n - 1]; };
async function create(url, name, extra) {
  const s = mk(url, name);
  await connected(s);
  s.emit("create", { name, playerId: s.pid, ...(extra || {}) });
  await waitFor(s, (r) => r.code, 4000, "a room for " + name);
  return s;
}
async function join(url, code, name, extra) {
  const s = mk(url, name);
  await connected(s);
  s.emit("join", { code, name, playerId: s.pid, ...(extra || {}) });
  await waitFor(s, (r) => r.players && r.players.length >= 2, 4000, name + " seated");
  return s;
}
/* A room of two humans, started. */
async function match(url, opts) {
  const a = await create(url, "Ana");
  const b = await join(url, a.st.code, "Ben");
  if (opts && Object.keys(opts).length) { a.emit("settings", opts); await waitFor(a, (r) => Object.keys(opts).every((k) => r.opts[k] === opts[k]), 3000, "settings"); }
  a.emit("start");
  await waitFor(a, (r) => r.status === "playing", 4000, "the match");
  await waitFor(b, (r) => r.status === "playing", 4000, "the match for Ben");
  return { a, b };
}
/* Put the ball where seat 0 (or 1) can score with disc 3 (or 8). Everyone else is parked out of the way. */
const PARK = [[6, 6], [54, 6], [6, 94], [54, 94], [6, 50], [54, 50], [8, 70], [52, 30], [8, 30], [52, 70]];
function goalSetup(seat, extra) {
  const bodies = PARK.map((p) => p.slice());
  const mirror = (x, y) => (seat === 0 ? [x, y] : [60 - x, 100 - y]);
  const disc = seat * 5 + 3;
  bodies[disc] = mirror(30, 66);
  bodies.push(mirror(30, 80));
  return { bodies, turn: seat, kickoff: false, ...(extra || {}) };
}
const aimOf = (seat) => (seat === 0 ? Math.PI / 2 : -Math.PI / 2);
const set = async (s, o) => { const v = s.st.v; s.emit("testSet", o); await waitFor(s, (r) => r.v > v, 3000, "testSet"); };
const flickAndWait = async (s, msg, ms = 6000) => { const v = s.st.v; s.emit("flick", msg); return waitFor(s, (r) => r.v > v, ms, "the flick"); };
const near = (a, b, e) => Math.abs(a - b) <= e;

(async () => {
  // ------------------------------------------------------------ a room forms
  section("a room forms");
  let a, b, code;
  {
    a = await create(URL, "Ana");
    code = a.st.code;
    check(code && /^[A-HJKMNPRTWXYZ]{6}$/.test(code), "room code is six letters from the 19-letter set (no digits)", code);
    check(a.seat === 0 && a.st.hostSeat === 0, "creator is seat 0 and host");
    check(a.joined && a.joined.code === code && typeof a.joined.playerId === "string", "created: joined {code, playerId}");
    const s = a.st;
    check(s.status === "lobby" && s.minPlayers === 2 && s.maxPlayers === 2, "lobby, 2 to 2 players");
    check(JSON.stringify(s.opts) === JSON.stringify({ goals: 3, minutes: 4, pitch: "toybox" }), "default opts", JSON.stringify(s.opts));
    check(JSON.stringify(s.pitch) === JSON.stringify({ w: 60, l: 100, goalX: [21, 39], goalDepth: 6, discR: 4, ballR: 2.2, postR: 0.9 }), "the pitch block", JSON.stringify(s.pitch));
    check(Array.isArray(s.bodies) && s.bodies.length === 11 && s.bodies.every((p) => p.length === 2), "11 [x,y] bodies");
    check(s.score && s.score[0] === 0 && s.score[1] === 0 && s.winner === null && s.golden === false, "score 0-0, no winner, not golden");
    check(typeof s.serverNow === "number" && typeof s.v === "number" && Array.isArray(s.chat) && Array.isArray(s.voice), "serverNow, v, chat, voice");
    check(s.reactionsOn === true && Array.isArray(s.reactions), "reactions ride in the state");
    check(s.players.length === 1 && s.players[0].name === "Ana" && s.players[0].bot === false && s.players[0].connected === true, "the player", JSON.stringify(s.players[0]));
    check(s.waiting && s.waiting.length === 0 && s.waitPos === 0, "the waiting line is empty");

    b = await join(URL, code, "Ben");
    check(b.seat === 1 && b.st.players.length === 2, "joiner takes seat 1");
    check(b.joined && b.joined.code === code, "joined {code, playerId}");

    const c = mk(URL, "Cy"); await connected(c);
    c.emit("join", { code, name: "Cy" });
    let e = await waitErr(c, 1);
    check(e && e.detail && e.detail.code === "full" && e.detail.op === "join" && typeof e.msg === "string", "a third player: err full", JSON.stringify(e));
    c.emit("join", { code: "ZZZZZZ", name: "Cy" });
    e = await waitErr(c, 2);
    check(e && e.detail.code === "not_found", "an unknown code: not_found", JSON.stringify(e));
    c.emit("create", { name: "   " });
    e = await waitErr(c, 3);
    check(e && e.detail.code === "name" && e.detail.op === "create", "no name: err name", JSON.stringify(e));
    c.close();
  }

  section("the host's settings");
  {
    a.emit("settings", { goals: 5, minutes: 3, pitch: "stadium" });
    await waitFor(a, (r) => r.opts.goals === 5 && r.opts.minutes === 3 && r.opts.pitch === "stadium", 3000, "settings");
    check(b.st.opts.goals === 5 && b.st.opts.pitch === "stadium", "the guest sees them");
    const v = a.st.v;
    for (const bad of [{ goals: 4 }, { goals: "3" }, { minutes: 9 }, { pitch: "moon" }, { goals: null }, {}]) a.emit("settings", bad);
    b.emit("settings", { goals: 1, minutes: 5, pitch: "rooftop" });
    await sleep(250);
    check(a.st.v === v && a.st.opts.goals === 5 && a.st.opts.minutes === 3 && a.st.opts.pitch === "stadium", "invalid values and a non-host change nothing");
    a.emit("settings", { goals: 1 });
    await waitFor(a, (r) => r.opts.goals === 1, 3000, "goals 1");
    a.emit("settings", { goals: 3, minutes: 4, pitch: "toybox" });
    await waitFor(a, (r) => r.opts.goals === 3 && r.opts.pitch === "toybox", 3000, "defaults back");
  }

  section("bots, and starting");
  {
    const s1 = await create(URL, "Solo");
    s1.emit("start");
    let e = await waitErr(s1, 1);
    check(e && e.detail.code === "nobody" && e.detail.op === "start", "start with one player: err nobody", JSON.stringify(e));
    check(s1.st.status === "lobby", "and it stays in the lobby");
    s1.emit("addBot", { level: "hard" });
    await waitFor(s1, (r) => r.players.length === 2, 3000, "the bot");
    check(s1.st.players[1].bot === true && s1.st.players[1].level === "hard" && s1.st.players[1].avatar, "a hard bot joined", JSON.stringify(s1.st.players[1]));
    s1.emit("addBot", { level: "easy" });
    e = await waitErr(s1, 2);
    check(e && e.detail.code === "full" && e.detail.op === "addBot", "a third seat: err full", JSON.stringify(e));
    s1.emit("removeBot");
    await waitFor(s1, (r) => r.players.length === 1, 3000, "the bot gone");
    s1.emit("addBot", { level: "wizard" });
    await waitFor(s1, (r) => r.players.length === 2, 3000, "a bot at an unknown level");
    check(s1.st.players[1].level === "normal", "an unknown level is normal", s1.st.players[1].level);
    s1.emit("removeBot"); await waitFor(s1, (r) => r.players.length === 1);
    s1.emit("addBot", {});
    await waitFor(s1, (r) => r.players.length === 2);
    check(s1.st.players[1].level === "normal", "no level is normal");
    s1.emit("addBot", null);                 // junk is fine, and full anyway
    s1.close();

    a.emit("start");
    await waitFor(a, (r) => r.status === "playing", 4000, "the match");
    await waitFor(b, (r) => r.status === "playing", 4000, "the match for Ben");
    const s = a.st;
    check(JSON.stringify(s.bodies) === JSON.stringify(formation(0)), "the kick-off formation, seat 0 kicking off", JSON.stringify(s.bodies));
    check(s.kickoff === true && s.turn === 0 && s.score[0] === 0 && s.golden === false, "kickoff, seat 0's turn");
    check(s.clockEndsAt > s.serverNow && s.clockEndsAt - s.serverNow <= 4 * 60000 + 1000 && s.clockEndsAt - s.serverNow > 4 * 60000 - 3000, "the match clock is four minutes", String(s.clockEndsAt - s.serverNow));
    check(s.turnEndsAt > s.serverNow, "a turn clock", String(s.turnEndsAt));
    check(s.lastShot === null, "no shot yet");
    check(typeof s.log === "string" && s.log.length > 0, "a log line");
    a.emit("settings", { goals: 5 });
    await sleep(150);
    check(a.st.opts.goals === 3, "settings are shut during a match");
  }

  // ------------------------------------------------------------ refusals
  section("out-of-turn, wrong-disc and bad flicks are refused");
  {
    const v = a.st.v;
    b.errs.length = 0;
    b.emit("flick", { disc: 7, aim: 1, power: 0.5 });          // Ben's own disc, but it is Ana's turn
    let e = await waitErr(b, 1);
    check(e && e.detail.code === "not_your_turn" && e.detail.op === "flick" && typeof e.msg === "string", "out of turn: not_your_turn", JSON.stringify(e));
    b.emit("flick", { disc: 2, aim: 1, power: 0.5 });
    await sleep(200);
    check(a.st.v === v && a.st.lastShot === null, "an out-of-turn flick changed the game");

    a.errs.length = 0;
    a.emit("flick", { disc: 6, aim: 1, power: 0.5 });          // the other side's disc
    e = await waitErr(a, 1);
    check(e && e.detail.code === "not_your_disc", "the other side's disc: not_your_disc", JSON.stringify(e));
    let n = 1;
    for (const bad of [{ disc: 10, aim: 1, power: 1 }, { disc: -1, aim: 1, power: 1 }, { disc: 1.5, aim: 1, power: 1 }, { disc: "1", aim: 1, power: 1 },
      { disc: 1, aim: "up", power: 1 }, { disc: 1, aim: 1, power: "full" }, { disc: 1, aim: NaN, power: 1 }, { disc: 1, aim: 1 }, { disc: 1, power: 1 }, { aim: 1, power: 1 },
      { disc: null, aim: 1, power: 1 }, { disc: 1, aim: null, power: 1 }, { disc: [1], aim: 1, power: 1 }]) {
      a.emit("flick", bad);
      e = await waitErr(a, ++n);
      check(e && e.detail.code === "bad_flick", "a bad flick: bad_flick " + JSON.stringify(bad), JSON.stringify(e && e.detail));
    }
    check(a.st.v === v && a.st.lastShot === null, "a refused flick changed the game");
    check(a.st.turn === 0 && a.st.kickoff === true, "and it is still seat 0's kick-off");
  }

  // ------------------------------------------------------------ a flick
  section("a flick");
  {
    const v0 = a.st.v;
    a.emit("flick", { disc: 3, aim: Math.atan2(50 - 45, 30 - 24), power: 0.7 });
    await waitFor(a, (r) => r.v > v0 && r.lastShot, 4000, "the flick");
    await waitFor(b, (r) => r.lastShot, 4000, "the flick for Ben");
    const s = a.st, sh = s.lastShot;
    check(sh && sh.seat === 0 && sh.disc === 3 && near(sh.power, 0.7, 1e-9) && sh.mv === 1 && typeof sh.at === "number", "lastShot: seat, disc, aim, power, mv, at", JSON.stringify({ ...sh, frames: undefined, events: undefined }));
    check(Array.isArray(sh.frames) && sh.frames.length > 20 && sh.frames.every((f) => f.length === 22), "frames: 22 numbers each (ball, then discs 0-9)");
    const f0 = sh.frames[0], start = formation(0);
    check(f0[0] === 30 && f0[1] === 50 && f0[2] === start[0][0] && f0[2 + 2 * 3] === 24 && f0[3 + 2 * 3] === 45, "the first frame is where everything rested", JSON.stringify(f0));
    const last = sh.frames[sh.frames.length - 1];
    check(last[0] === s.bodies[10][0] && last[1] === s.bodies[10][1] && last[2] === s.bodies[0][0] && last[2 + 2 * 3] === s.bodies[3][0], "the last frame is where the state says the bodies rest");
    check(Array.isArray(sh.events) && sh.events.every((e) => typeof e.f === "number" && typeof e.k === "string"), "events: {f, k}");
    check(sh.events.some((e) => e.k === "kick" && e.a === 3 && e.b === 10 && e.s > 0 && e.s <= 1), "a disc-ball kick event with a speed", JSON.stringify(sh.events.slice(0, 3)));
    check(sh.result === "stop" || sh.result === "goal" || sh.result === "timeout", "a result", sh.result);
    check(s.kickoff === false && s.turn === (sh.result === "goal" ? s.turn : 1), "the kick-off is over and the turn passed");
    check(JSON.stringify(a.st.lastShot) === JSON.stringify(b.st.lastShot), "both clients see the same shot");
    check(s.bodies.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] * 100 - Math.round(p[0] * 100)) < 1e-6), "bodies have 2 decimals");
    check(s.turnEndsAt > Date.now() - 5000, "the next turn has a clock");
  }

  section("power is clamped; the flick's `at` is accepted");
  {
    const { a: x, b: y } = await match(URL);
    await flickAndWait(x, { disc: 1, aim: 0.3, power: 9, at: Date.now() - 50 });
    check(x.st.lastShot.power === 1, "power above 1 is 1", String(x.st.lastShot.power));
    check(x.st.lastShot.at <= Date.now() && x.st.lastShot.at >= Date.now() - 2000, "at is a server time");
    await waitFor(y, (r) => r.turn === 1 && r.turnEndsAt, 3000, "Ben's turn");
    await flickAndWait(y, { disc: 5, aim: 2, power: -3, at: "yesterday" });
    check(y.st.lastShot.power === 0 && y.st.lastShot.seat === 1 && y.st.lastShot.mv === 2, "negative power is 0 (a tap), a junk `at` is ignored; mv counts", JSON.stringify([y.st.lastShot.power, y.st.lastShot.mv]));
    x.close(); y.close();
  }

  // ------------------------------------------------------------ passes
  section("a pass to a teammate earns another flick, at most two in a row");
  {
    const { a: x, b: y } = await match(URL);
    // Seat 0's disc 3, the ball and disc 4 in a line up the middle; everyone else out of the way.
    const passSetup = () => ({ turn: 0, kickoff: false, bodies: [
      [8, 8], [52, 8], [8, 20], [30, 30], [30, 55],
      [8, 92], [52, 92], [8, 80], [52, 80], [52, 64],
      [30, 37] ] });
    for (let k = 1; k <= 3; k++) {
      await set(x, passSetup());
      await flickAndWait(x, { disc: 3, aim: Math.PI / 2, power: 0.55 });
      const sh = x.st.lastShot;
      const kicks = sh.events.filter((e) => e.k === "kick").map((e) => e.a);
      if (k <= 2) {
        check(sh.pass && sh.pass.from === 3 && sh.pass.to === 4, `pass ${k}: the shot names the pass 3 -> 4`, JSON.stringify(sh.pass) + " kicks " + kicks);
        check(sh.events.some((e) => e.k === "pass" && e.a === 3 && e.b === 4 && sh.pass && e.f === sh.pass.f), `pass ${k}: a pass event at the receiving touch`);
        check(x.st.turn === 0 && x.st.passRun === k && /Pass!/.test(x.st.log), `pass ${k}: still seat 0's turn, passRun ${k}`, JSON.stringify([x.st.turn, x.st.passRun, x.st.log]));
      } else {
        check(!sh.pass && x.st.turn === 1 && x.st.passRun === 0, "a third pass in a row earns nothing: the turn goes over", JSON.stringify([sh.pass, x.st.turn, x.st.passRun]));
      }
    }
    // A flick with no pass: the turn goes over as ever.
    await waitFor(y, (r) => r.turn === 1 && r.turnEndsAt, 3000, "Ben's turn");
    await flickAndWait(y, { disc: 9, aim: 0, power: 0.3 });
    check(!y.st.lastShot.pass && y.st.turn === 0 && y.st.passRun === 0, "no pass, no bonus", JSON.stringify([y.st.lastShot.pass, y.st.turn]));
    x.close(); y.close();
  }

  // ------------------------------------------------------------ goals
  section("a goal: the shot, the pause, the reset, the conceding side kicks off");
  {
    const { a: x, b: y } = await match(URL);
    await set(x, goalSetup(0));
    const bodiesBefore = x.st.bodies;
    check(near(bodiesBefore[10][1], 80, 0.01) && x.st.turn === 0 && x.st.kickoff === false, "testSet put the ball and the turn");
    const t0 = Date.now();
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    const sh = x.st.lastShot;
    check(sh.result === "goal" && sh.goalFor === 0, "the shot is a goal for seat 0", sh.result + " " + sh.goalFor);
    check(sh.events.some((e) => e.k === "goal" && e.a === 0), "with a goal event naming seat 0");
    check(x.st.score[0] === 1 && x.st.score[1] === 0, "1-0", JSON.stringify(x.st.score));
    check(x.st.bodies[10][1] > 102.2 && x.st.bodies[10][0] > 21 && x.st.bodies[10][0] < 39, "the bodies still show the ball in the net during the pause", JSON.stringify(x.st.bodies[10]));
    check(x.st.turnEndsAt === null, "no turn clock during the pause");
    check(/GOAL/i.test(x.st.log), "the log says goal", x.st.log);
    // nobody may flick during the pause
    x.errs.length = 0; y.errs.length = 0;
    x.emit("flick", { disc: 1, aim: 1, power: 0.5 });
    y.emit("flick", { disc: 6, aim: 1, power: 0.5 });
    const e1 = await waitErr(x, 1), e2 = await waitErr(y, 1);
    check(e1 && e1.detail.code === "not_your_turn" && e2 && e2.detail.code === "not_your_turn", "no flick during the pause", JSON.stringify([e1, e2]));
    await waitFor(x, (r) => r.kickoff === true && r.status === "playing", 4000, "the reset");
    const dt = Date.now() - t0;
    check(dt >= 380, "the reset waited out GOAL_PAUSE_MS (400)", dt + " ms");
    check(x.st.turn === 1, "seat 1 conceded, so seat 1 kicks off", String(x.st.turn));
    check(JSON.stringify(x.st.bodies) === JSON.stringify(formation(1)), "the formation, seat 1 kicking off");
    check(x.st.score[0] === 1 && x.st.turnEndsAt > Date.now(), "the score stands and the turn clock runs");
    check(x.st.lastShot.goalFor === 0, "lastShot is still the goal shot");
    // seat 1 can now flick, seat 0 cannot
    x.errs.length = 0;
    x.emit("flick", { disc: 1, aim: 1, power: 0.5 });
    check((await waitErr(x, 1)).detail.code === "not_your_turn", "the kicking side has the turn");
    await flickAndWait(y, { disc: 8, aim: Math.atan2(50 - 55, 30 - 36), power: 0.5 });
    check(y.st.lastShot.seat === 1 && y.st.kickoff === false, "seat 1 kicked off");
    // an own goal counts for the other side
    await waitFor(x, (r) => r.turn === 0, 3000);
    const own = PARK.map((p) => p.slice()); own[3] = [30, 40]; own.push([30, 24]);   // seat 0 flicks the ball into its OWN net
    await set(x, { bodies: own, turn: 0, kickoff: false });
    await flickAndWait(x, { disc: 3, aim: -Math.PI / 2, power: 0.8 });
    check(x.st.lastShot.goalFor === 1 && x.st.score[1] === 1, "an own goal is the other side's", JSON.stringify([x.st.lastShot.goalFor, x.st.score]));
    await waitFor(x, (r) => r.kickoff === true, 4000, "the reset after the own goal");
    check(x.st.turn === 0, "seat 0 conceded, seat 0 kicks off");
    x.close(); y.close();
  }

  section("first to opts.goals ends the match");
  {
    const { a: x, b: y } = await match(URL, { goals: 1 });
    await set(x, goalSetup(0));
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    check(x.st.status === "over" && x.st.winner === 0, "first to 1: over, seat 0 wins", x.st.status + " " + x.st.winner);
    check(x.st.turnEndsAt === null && x.st.lastShot.result === "goal", "no clock, and the goal shot is in the state");
    await sleep(600);
    check(x.st.status === "over" && x.st.bodies[10][1] > 102, "no reset after the last goal", JSON.stringify(x.st.bodies[10]));
    check(/wins/i.test(x.st.log), "the log names the winner", x.st.log);
    x.errs.length = 0;
    x.emit("flick", { disc: 3, aim: 1, power: 0.5 });
    await sleep(150);
    check(x.st.status === "over", "no flicking when it is over");
    x.close(); y.close();

    const m = await match(URL, { goals: 2 });
    await set(m.b, goalSetup(1));
    await set(m.b, { turn: 1 });
    await flickAndWait(m.b, { disc: 8, aim: aimOf(1), power: 0.8 });
    check(m.b.st.score[1] === 1 && m.b.st.status === "playing" && m.b.st.winner === null, "first to 2: one goal does not end it");
    await waitFor(m.b, (r) => r.kickoff === true, 4000, "the reset");
    check(m.b.st.turn === 0, "seat 0 conceded, seat 0 kicks off");
    await set(m.b, goalSetup(1));
    await flickAndWait(m.b, { disc: 8, aim: aimOf(1), power: 0.8 });
    check(m.b.st.status === "over" && m.b.st.winner === 1, "the second goal wins it for seat 1", m.b.st.status + " " + m.b.st.winner);
    m.a.close(); m.b.close();
  }

  // ------------------------------------------------------------ clock
  section("the clock, full time and the golden goal");
  {
    // 1. time up, ahead: the leader wins at the end of the flick
    let { a: x, b: y } = await match(URL);
    await set(x, { score: [1, 0], clockMs: 800 });
    await flickAndWait(x, { disc: 1, aim: 0.3, power: 0.3 });
    check(x.st.status === "playing", "before time the game goes on (no early end)");
    await waitFor(y, (r) => r.turn === 1, 3000);
    await sleep(900);                                       // the clock runs out between flicks
    check(x.st.status === "playing" && x.st.winner === null, "the clock running out does not stop a turn in the middle");
    await flickAndWait(y, { disc: 5, aim: -0.3, power: 0.3 });
    check(x.st.status === "over" && x.st.winner === 0, "at the end of the next flick the leader wins", x.st.status + " " + x.st.winner);
    x.close(); y.close();

    // 2. time up and level: golden goal, play on; the next goal wins
    ({ a: x, b: y } = await match(URL));
    await set(x, { score: [1, 1], clockMs: -50, golden: false });
    await flickAndWait(x, { disc: 1, aim: 0.3, power: 0.3 });
    check(x.st.status === "playing" && x.st.golden === true && x.st.winner === null, "tied at time: golden, play on", JSON.stringify([x.st.status, x.st.golden]));
    check(/golden/i.test(x.st.log), "the log says golden goal", x.st.log);
    await waitFor(y, (r) => r.turn === 1, 3000);
    await flickAndWait(y, { disc: 5, aim: -0.3, power: 0.3 });
    check(x.st.status === "playing" && x.st.golden === true, "golden goal: still level, still playing");
    await set(x, goalSetup(0));
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    check(x.st.status === "over" && x.st.winner === 0 && x.st.score[0] === 2, "the golden goal wins it", x.st.status + " " + x.st.winner + " " + x.st.score);
    x.close(); y.close();

    // 3. a goal after time while ahead by one: the leader wins; a goal that levels it goes to golden
    ({ a: x, b: y } = await match(URL, { goals: 5 }));
    await set(x, { score: [0, 1], clockMs: -50, golden: true });
    await set(x, goalSetup(0, { golden: true }));
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    check(x.st.status === "over" && x.st.winner === 0 && x.st.score[0] === 1 && x.st.score[1] === 1, "a golden goal wins even when it only levels the score", x.st.status + " " + x.st.winner + " " + x.st.score);
    x.close(); y.close();
    ({ a: x, b: y } = await match(URL, { goals: 5 }));
    await set(x, { score: [0, 1], clockMs: -50 });
    await set(x, goalSetup(0));
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    check(x.st.status === "playing" && x.st.golden === true && x.st.score[0] === 1 && x.st.score[1] === 1, "a goal at full time that levels it goes to golden goal", x.st.status + " " + x.st.golden + " " + x.st.score);
    x.close(); y.close();
  }

  // ------------------------------------------------------------ turn timeout, AFK
  section("the turn timeout plays an easy flick; three in a row hand the seat to a bot");
  {
    const x = await create(URL_TURN, "Idle");
    x.emit("addBot", { level: "easy" });
    await waitFor(x, (r) => r.players.length === 2);
    x.emit("start");
    await waitFor(x, (r) => r.status === "playing");
    const t0 = Date.now();
    check(x.st.turnEndsAt - x.st.serverNow <= 1600 && x.st.turnEndsAt - x.st.serverNow > 1000, "the turn clock is TURN_MS (1500 on this server)", String(x.st.turnEndsAt - x.st.serverNow));
    await waitFor(x, (r) => r.lastShot && r.lastShot.seat === 0, 5000, "the auto-flick");
    const dt = Date.now() - t0;
    check(dt >= 1300 && dt < 3500, "it came after the turn clock ran out", dt + " ms");
    check(x.st.lastShot.disc >= 0 && x.st.lastShot.disc <= 4, "with one of the idle player's own discs", String(x.st.lastShot.disc));
    check(x.st.players[0].botControlled === false, "one timeout does not hand over the seat");
    await waitFor(x, (r) => r.players[0].botControlled === true, 12000, "a bot taking over after three timeouts");
    check(x.st.players[0].botControlled === true, "a bot plays for the idle player", JSON.stringify(x.st.players[0]));
    // the player acts again: the seat is theirs
    await waitFor(x, (r) => r.turn === 0 && r.players[0].botControlled, 6000, "my turn again");
    x.emit("takeSeat");
    await waitFor(x, (r) => r.players[0].botControlled === false, 3000, "the seat back");
    check(x.st.players[0].botControlled === false, "takeSeat takes it back");
    x.close();
  }
  section("a disconnected player has the short clock");
  {
    const x = await create(URL_TURN, "Here"), y = await join(URL_TURN, x.st.code, "Gone");
    x.emit("start");
    await waitFor(x, (r) => r.status === "playing");
    await flickAndWait(x, { disc: 1, aim: 0.4, power: 0.3 });
    await waitFor(x, (r) => r.turn === 1 && r.turnEndsAt, 3000);
    y.close();
    await waitFor(x, (r) => r.players[1].connected === false, 3000, "Gone going dark");
    const t0 = Date.now();
    await waitFor(x, (r) => r.lastShot && r.lastShot.seat === 1, 5000, "the flick for the absent player");
    const dt = Date.now() - t0;
    check(dt < 1200, "AFK_MS (300), not TURN_MS (1500), for someone who is gone", dt + " ms");
    check(x.st.players[1].connected === false, "they are still shown as not connected");
    x.close();
  }

  // ------------------------------------------------------------ rematch
  section("rematch");
  {
    const { a: x, b: y } = await match(URL, { goals: 1 });
    await set(x, goalSetup(0));
    await flickAndWait(x, { disc: 3, aim: aimOf(0), power: 0.8 });
    check(x.st.status === "over", "the match is over");
    y.emit("rematch");
    await sleep(200);
    check(x.st.status === "over", "a guest cannot start the rematch");
    x.emit("rematch");
    await waitFor(x, (r) => r.status === "playing", 3000, "the rematch");
    check(x.st.score[0] === 0 && x.st.score[1] === 0 && x.st.winner === null && x.st.golden === false, "score and winner reset");
    check(x.st.lastShot === null && x.st.kickoff === true, "no shot, kick-off");
    check(x.st.turn === 1 && JSON.stringify(x.st.bodies) === JSON.stringify(formation(1)), "the other side kicks off the second match", String(x.st.turn));
    check(x.st.clockEndsAt - x.st.serverNow > 4 * 60000 - 3000, "a fresh clock");
    check(/Rematch/.test(x.st.log), "the log says rematch", x.st.log);
    x.emit("rematch");
    await sleep(100);
    check(x.st.status === "playing", "rematch in a match does nothing");
    x.close(); y.close();
  }

  // ------------------------------------------------------------ leave / disconnect
  section("leave and disconnect");
  {
    // leaving mid-match forfeits to a human opponent
    let { a: x, b: y } = await match(URL);
    y.emit("leave");
    await waitFor(x, (r) => r.status === "over", 3000, "the forfeit");
    check(x.st.winner === 0 && x.st.players[1].left === true, "a player who leaves mid-match forfeits: the other wins", x.st.winner + " " + JSON.stringify(x.st.players[1]));
    check(/left/.test(x.st.log), "the log says who left", x.st.log);
    x.emit("rematch");
    const e = await waitErr(x, 1);
    check(e && e.detail.code === "nobody", "no rematch with nobody to play", JSON.stringify(e));
    x.close(); y.close();

    // a disconnect is not a leave: the seat waits, and the player comes back by playerId
    ({ a: x, b: y } = await match(URL));
    const pid = y.pid;
    y.close();
    await waitFor(x, (r) => r.players[1].connected === false, 3000, "the disconnect");
    check(x.st.status === "playing" && x.st.players[1].left === false, "still in the match, not left");
    const y2 = mk(URL, "Ben"); await connected(y2);
    y2.emit("join", { code: x.st.code, name: "Ben", playerId: pid });
    await waitFor(y2, (r) => r.players && r.players[1].connected === true, 3000, "the reconnect");
    check(y2.seat === 1 && x.st.players[1].connected === true, "back in seat 1 on the same playerId");
    x.close(); y2.close();

    // in the lobby a leaver leaves and the host passes on
    const h = await create(URL, "Host"), g = await join(URL, h.st.code, "Guest");
    h.emit("leave");
    await waitFor(g, (r) => r.players.length === 1, 3000, "the host leaving");
    check(g.st.hostSeat === 0 && g.seat === 0 && g.st.players[0].name === "Guest", "the guest is the host now", JSON.stringify([g.st.hostSeat, g.seat]));
    const k = await join(URL, g.st.code, "Third");
    check(k.seat === 1, "the freed seat can be taken");
    // a room with only a bot left is gone
    const s = await create(URL, "Alone"); s.emit("addBot", { level: "easy" }); await waitFor(s, (r) => r.players.length === 2);
    const c2 = s.st.code;
    s.emit("start"); await waitFor(s, (r) => r.status === "playing");
    s.emit("leave");
    await sleep(300);
    const probe = mk(URL, "Probe"); await connected(probe);
    probe.emit("join", { code: c2, name: "Probe" });
    const pe = await waitErr(probe, 1);
    check(pe && pe.detail.code === "not_found", "a room with only a bot left is closed", JSON.stringify(pe));
    [g, k, h, probe].forEach((q) => q.close());
  }

  // ------------------------------------------------------------ hostile payloads
  section("a hostile payload cannot take the server down");
  {
    const x = mk(URL, "X");
    await connected(x);
    const events = ["create", "join", "settings", "addBot", "removeBot", "start", "flick", "rematch", "takeSeat", "pushToken", "presence", "chat", "voice",
      "react", "reactionsOn", "testSet", "leave"];
    const junk = [null, 7, "text", [1, 2], true, undefined, {}, { disc: {}, aim: {}, power: [] }, { bodies: "x", score: "y", clockMs: "z" }];
    for (const ev of events) for (const bad of junk) x.emit(ev, bad);
    x.emit("create", { name: "Mallory" });
    await waitFor(x, (r) => r.code, 4000, "a room after the junk");
    x.emit("addBot", { level: "easy" });
    await waitFor(x, (r) => r.players.length === 2);
    x.emit("start");
    await waitFor(x, (r) => r.status === "playing");
    for (const ev of events.filter((e) => e !== "leave")) for (const bad of junk) x.emit(ev, bad);
    x.emit("flick", { disc: 3, aim: 1e308, power: 1e308 });
    x.emit("flick", { disc: 3, aim: -1e308, power: 1e-300 });
    x.emit("testSet", { bodies: [[NaN, 1]], score: [-1, 1.5], clockMs: Infinity, turn: "1" });
    x.emit("voice", { kind: "signal", to: 1, data: "x".repeat(30000) });
    x.emit("voice", { kind: "signal", to: 0, data: { a: 1 } });
    x.emit("chat", { text: { toString: 1 } });
    x.emit("chat", { text: "y".repeat(100000) });
    await sleep(500);
    const y = await create(URL, "StillUp");
    check(!!y.st.code, "the server stopped answering after the junk");
    check(JSON.stringify(x.st.bodies).length < 2000 && x.st.bodies.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), "no junk reached the bodies");
    console.log(`  ${events.length * junk.length * 2} junk frames; the server still seats a new room`);
    x.close(); y.close();
  }

  // ------------------------------------------------------------ one socket, one room
  section("one socket, one room");
  {
    const x = await create(URL, "Xena");
    const roomA = x.st.code;
    const y = await join(URL, roomA, "Yuri");
    x.emit("create", { name: "Xena", playerId: x.pid });
    await waitFor(x, (r) => r.code !== roomA, 4000, "Xena's second room");
    const roomB = x.st.code;
    await waitFor(y, (r) => r.players[0].connected === false, 4000, "Xena's old seat going dark");
    check(y.st.players[0].connected === false, "the socket that moved still holds its old seat");
    const before = x.hist.length;
    y.emit("chat", { text: "anyone here?" });
    await waitFor(y, (r) => (r.chat || []).length > 0, 4000, "a chat line in the old room");
    await sleep(200);
    check(x.hist.slice(before).every((r) => r.code === roomB), "a socket still hears the room it left");
    x.emit("join", { code: roomA, name: "Xena", playerId: x.pid });
    await waitFor(y, (r) => r.players[0].connected === true, 4000, "Xena back in the first room");
    check(x.st.code === roomA, "rejoining the first room took");
    x.close(); y.close();
  }
  section("a reconnect is not undone by the old socket going");
  {
    const host = await create(URL, "Holly");
    const old = await join(URL, host.st.code, "Rae");
    const fresh = mk(URL, "Rae"); fresh.pid = old.pid;
    await connected(fresh);
    fresh.emit("join", { code: host.st.code, name: "Rae", playerId: old.pid });
    await waitFor(fresh, () => fresh.seat === 1, 4000, "the new socket seated");
    old.disconnect();
    await sleep(400);
    check(host.st.players[1].connected === true, "the old socket's timeout marked a connected player away");
    fresh.disconnect();
    await waitFor(host, (r) => r.players[1].connected === false, 4000, "the last socket going");
    host.close();
  }

  // ------------------------------------------------------------ names
  section("names: 18 whole characters, on every path");
  {
    const cases = [
      ["\u{1F44D}\u{1F3FD}".repeat(25), "\u{1F44D}\u{1F3FD}".repeat(18), "skin-toned thumbs"],
      ["abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqr", "plain letters"],
      ["x".repeat(100000), "x".repeat(18), "a 100 KB name"],
      ["<Tom & \"Jerry\">", "Tom  Jerry", "markup"],
    ];
    for (const [given, want, what] of cases) {
      const s = await create(URL, given);
      check(s.st.players[0].name === want, `${what}: the name came back wrong`, JSON.stringify(s.st.players[0].name).slice(0, 60));
      s.close();
    }
    const s = await create(URL, "Avi", { avatar: "\u{1F60E}\u{1F60E}" });
    check(s.st.players[0].avatar === "\u{1F60E}", "an avatar is one character", JSON.stringify(s.st.players[0].avatar));
    s.close();
  }

  // ------------------------------------------------------------ chat, voice, presence
  section("chat, voice and presence");
  {
    const { a: x, b: y } = await match(URL);
    const before = (x.st.chat || []).length;
    x.emit("chat", { text: "nice flick" });
    await waitFor(x, (r) => (r.chat || []).length > before, 4000, "the chat line");
    const line = x.st.chat[x.st.chat.length - 1];
    check(line && line.k === "t" && line.x === "nice flick" && !!line.n && typeof line.t === "number", "a chat line arrives with author and time", JSON.stringify(line));
    check(y.st.chat.length === x.st.chat.length, "and everyone has it");
    const n1 = x.st.chat.length;
    x.emit("chat", { text: "and another" });
    await sleep(200);
    check(x.st.chat.length === n1, "the chat cooldown holds");
    await sleep(900);
    x.emit("chat", { sticker: "not-a-real-sticker" });
    await sleep(250);
    check(x.st.chat.length === n1, "an unknown sticker is refused");
    x.emit("chat", { sticker: "fire" });
    await waitFor(x, (r) => r.chat.length > n1, 4000, "the sticker");
    check(x.st.chat[x.st.chat.length - 1].k === "s", "a sticker arrives as one");
    x.emit("voice", { kind: "join" });
    await waitFor(x, (r) => (r.voice || []).includes(0), 4000, "the voice seat");
    let got = null; y.on("voice", (m) => { got = m; });
    x.emit("voice", { kind: "signal", to: 1, data: { sdp: "x" } });
    for (let i = 0; i < 100 && !got; i++) await sleep(10);
    check(got && got.kind === "signal" && got.from === 0 && got.data.sdp === "x", "a voice signal is carried to the other seat", JSON.stringify(got));
    x.emit("voice", { kind: "leave" });
    await waitFor(x, (r) => !(r.voice || []).includes(0), 4000, "the voice seat clearing");
    const v = x.st.v;
    x.emit("presence", { away: true });
    x.emit("pushToken", { token: "nonsense" });
    x.emit("pushToken", { token: "a".repeat(64) });
    await sleep(250);
    check(x.st.v >= v, "presence or pushToken broke the room");
    x.close(); y.close();
  }

  // ------------------------------------------------------------ a whole match between two bots
  section("a whole match between two bots");
  {
    const x = await create(URL, "Spectator");
    x.emit("settings", { goals: 2, minutes: 3 });
    x.emit("addBot", { level: "hard" });
    await waitFor(x, (r) => r.players.length === 2 && r.opts.goals === 2);
    x.emit("start");
    await waitFor(x, (r) => r.status === "playing");
    await set(x, { botControlled: [true, false], clockMs: 40000 });
    check(x.st.players[0].botControlled === true && x.st.players[1].bot === true, "both seats are bots");
    const t0 = Date.now();
    await waitFor(x, (r) => r.status === "over", 100000, "the bots' match");
    const secs = (Date.now() - t0) / 1000;
    check(x.st.status === "over" && (x.st.winner === 0 || x.st.winner === 1), "the match finished with a winner", String(x.st.winner));
    const [s0, s1] = x.st.score;
    check(x.st.lastShot && x.st.lastShot.mv >= 3, "several flicks were played", String(x.st.lastShot && x.st.lastShot.mv));
    // everything that came over the wire was a legal flick: bodies finite, inside the pitch
    check(x.hist.every((r) => r.bodies.every((p) => Number.isFinite(p[0]) && p[0] >= -0.01 && p[0] <= 60.01 && p[1] >= -6.01 && p[1] <= 106.01)), "every state the bots produced had its bodies on the pitch");
    check(x.hist.every((r, i, h) => i === 0 || r.v >= h[i - 1].v), "state versions only go up");
    console.log(`  finished ${s0}-${s1} (${x.st.winner === 0 ? "the stand-in" : "the hard bot"} won) after ${x.st.lastShot.mv} flicks in ${secs.toFixed(1)} s; ${x.st.log}`);
    x.close();
  }

  console.log(failures === 0 ? `\nrules: all good (${checks} checks)\n` : `\nrules: ${failures} failure(s)\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
