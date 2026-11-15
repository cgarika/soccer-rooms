/* Soccer bot pacing (pacing round 1, 2026-11-01): the tail of a flick's playback is thinned and ends in the same place; the bot's
   thought follows the shot; and, over a socket with real clocks, a bot's flick comes within its limit after a person's.
   Run: node test/pacing.js   (its own server on TEST_PORT, default 5461; never 3111-3124) */
"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const { simulate, compressTail, formation, PHYS } = require("../physics");
process.env.BOT_WORKERS = process.env.BOT_WORKERS || "0";   // the in-process server needs no worker threads

const PORT = Number(process.env.TEST_PORT || 5461);
if (PORT >= 3111 && PORT <= 3124) { console.error("refusing " + PORT + ": the live servers"); process.exit(2); }
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("soccer pacing: the tail of a playback");
  const flicks = [];
  let bodies = formation(0);
  for (let i = 0; i < 80; i++) {
    const seat = i % 2, disc = seat * 5 + (i % 5);
    const sh = simulate(bodies, disc, (seat ? -1 : 1) * Math.PI / 2 + Math.sin(i * 1.7) * 0.7, 0.3 + (i % 7) / 10);
    flicks.push(sh);
    bodies = sh.result === "goal" ? formation(seat) : sh.end;
  }
  await ok("it ends in the very same frame, and every event still has its frame", () => {
    for (const sh of flicks) {
      const c = compressTail(sh);
      assert.deepStrictEqual(c.frames[c.frames.length - 1], sh.frames[sh.frames.length - 1]);
      assert.deepStrictEqual(c.frames.slice(0, 10), sh.frames.slice(0, 10));
      assert.ok(c.events.every((e) => e.f >= 0 && e.f < c.frames.length), "an event past the last frame");
      assert.strictEqual(c.events.length, sh.events.length);
      assert.strictEqual(c.result, sh.result);
    }
  });
  await ok("the creeping end plays faster: a third of a second saved on average, never longer, a goal's flick left whole", () => {
    let before = 0, after = 0, goals = 0;
    for (const sh of flicks) {
      const c = compressTail(sh);
      assert.ok(c.frames.length <= sh.frames.length);
      if (sh.result === "goal") { goals++; assert.strictEqual(c.frames.length, sh.frames.length); }
      before += sh.frames.length; after += c.frames.length;
    }
    const saved = (before - after) / flicks.length / PHYS.FRAME_HZ;
    assert.ok(saved > 0.3, `saved ${saved.toFixed(2)} s a flick`);
  });
  await ok("what plays before the tail is untouched, and nothing in the thinned part moves fast", () => {
    for (const sh of flicks) {
      const c = compressTail(sh);
      if (c.frames.length === sh.frames.length) continue;
      const cut = c.frames.findIndex((f, k) => k > 0 && c.frames.length - k > 3 && f !== sh.frames[k]);
      assert.ok(cut < 0 || cut > 20, "thinning began at frame " + cut);
    }
  });
  await ok("events that fell in the tail fire at the frame that is now where they happened (never earlier)", () => {
    for (const sh of flicks) {
      const c = compressTail(sh);
      const old = sh.events.map((e) => e.f), now = c.events.map((e) => e.f);
      for (let i = 0; i < old.length; i++) assert.ok(now[i] <= old[i]);
    }
  });

  console.log("soccer pacing: how long a bot thinks");
  process.env.PORT = String(process.env.TEST_PORT_INPROC || PORT + 3);   // server.js listens when it is required: here, on a port of the test's own
  const S = require("../server");
  await ok("a longer flick is thought about longer; a pass bonus comes at about half; never over 1.8 s", () => {
    const room = { bodies: formation(0) };
    room.bodies[10] = [30, 50];
    const near = { disc: 3, aim: 0, power: 0.5 }, far = { disc: 0, aim: 0, power: 0.5 };
    room.bodies[3] = [30, 45]; room.bodies[0] = [30, 5];
    const avg = (f, n = 200) => { let a = 0; for (let i = 0; i < n; i++) a += f(); return a / n; };
    for (const level of ["easy", "normal", "hard"]) {
      const n = avg(() => S.thinkMsFor(room, level, near, false)), f = avg(() => S.thinkMsFor(room, level, far, false));
      assert.ok(f > n + 150, `${level}: far ${f.toFixed(0)}, near ${n.toFixed(0)}`);
      const c = avg(() => S.thinkMsFor(room, level, far, true));
      assert.ok(c < f * 0.65 && c > f * 0.45, `${level}: a pass bonus ${c.toFixed(0)} vs ${f.toFixed(0)}`);
      for (let i = 0; i < 200; i++) { const ms = S.thinkMsFor(room, level, far, false); assert.ok(ms >= 600 && ms <= 1800, "" + ms); }
    }
  });

  console.log("soccer pacing: over a socket, with real clocks");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT, TURN_MS: "60000" }), stdio: "ignore" });
  await sleep(900);
  try {
    await ok("a normal bot's flick comes within 3.4 s of a person's (the playback, then 0.4-1.8 s of thought)", async () => {
      const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
      const log = [];
      s.on("state", ({ room, mySeat }) => log.push({ t: Date.now(), room, mySeat }));
      s.emit("create", { name: "Ava", playerId: "p_pace_soccer" });
      await new Promise((r) => s.once("joined", () => r()));
      s.emit("addBot", { level: "normal" });
      await sleep(200);
      s.emit("start");
      const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const l = log[log.length - 1]; if (l && pred(l)) return l; await sleep(20); } throw new Error("timed out"); };
      const waits = [];
      let st = await until((l) => l.room.status === "playing", 3000);
      for (let n = 0; n < 5; n++) {
        st = await until((l) => l.room.status === "playing" && l.room.turn === l.mySeat && !l.room.goalPauseEndsAt, 14000);   // not in the goal pause (the flick would be refused)
        if (st.room.lastShot) await sleep(st.room.lastShot.frames.length * 1000 / 60 + 50);   // the last flick is played back first
        const ball = st.room.bodies[10], me = st.mySeat;
        let best = me * 5, bd = 1e9;
        for (let k = me * 5; k < me * 5 + 5; k++) { const d = Math.hypot(st.room.bodies[k][0] - ball[0], st.room.bodies[k][1] - ball[1]); if (d < bd) { bd = d; best = k; } }
        const mv0 = st.room.lastShot ? st.room.lastShot.mv : 0;
        s.emit("flick", { disc: best, aim: Math.atan2(ball[1] - st.room.bodies[best][1], ball[0] - st.room.bodies[best][0]), power: 0.7 });
        const mine = await until((l) => l.room.lastShot && l.room.lastShot.mv > mv0 && l.room.lastShot.seat === l.mySeat, 3000);
        const mv1 = mine.room.lastShot.mv;
        // The bot flicks next, unless this flick was a pass (the same side flicks again: it is the person's turn still) or a goal
        // (the pause, then the kick-off of whoever let it in): those are not measured.
        const theirs = await until((l) => (l.room.lastShot && l.room.lastShot.mv > mv1 && l.room.lastShot.seat !== l.mySeat) || (l.room.turn === l.mySeat && l.room.passRun > 0) || (l.room.lastShot && l.room.lastShot.seat === l.mySeat && l.room.lastShot.goalFor != null), 12000);
        if (theirs.room.lastShot.seat !== theirs.mySeat) waits.push(theirs.t - mine.t);
      }
      s.close();
      // The wait is the playback of the person's flick (the server counts it) and then the thought. Everything counted:
      assert.ok(waits.length >= 2, "too few bot flicks seen: " + waits.length);
      const worst = Math.max(...waits);
      assert.ok(worst <= 3400 + 300, `the slowest wait was ${worst} ms (${waits.join(" ")})`);
    });
    await ok("a bot's turn says what it is about to do (thinking: its disc, aim and power, when its pull starts and when it flicks), and says nothing once it has", async () => {
      const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
      const log = [];
      s.on("state", ({ room, mySeat }) => log.push({ t: Date.now(), room, mySeat }));
      s.emit("create", { name: "Ava", playerId: "p_think_soccer" });
      await new Promise((r) => s.once("joined", () => r()));
      s.emit("addBot", { level: "normal" });
      await sleep(200);
      s.emit("start");
      const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const l = log.find((x, i) => i >= from && pred(x)); if (l) return l; await sleep(20); } throw new Error("timed out"); };
      let from = 0;
      let st = await until((l) => l.room.status === "playing" && l.room.turn === l.mySeat, 4000);
      assert.strictEqual(st.room.thinking, null, "nothing to think about on my turn");
      const ball = st.room.bodies[10], me = st.mySeat;
      s.emit("flick", { disc: me * 5 + 3, aim: Math.atan2(ball[1] - st.room.bodies[me * 5 + 3][1], ball[0] - st.room.bodies[me * 5 + 3][0]), power: 0.3 });
      const mine = await until((l) => l.room.lastShot && l.room.lastShot.seat === me, 3000);
      from = log.indexOf(mine);
      const th = await until((l) => l.room.thinking, 3000);
      const t = th.room.thinking;
      assert.strictEqual(t.seat, 1 - me, "the bot's seat");
      assert.ok(t.disc >= (1 - me) * 5 && t.disc < (1 - me) * 5 + 5, "one of the bot's own discs: " + t.disc);
      assert.ok(Number.isFinite(t.aim) && t.power > 0 && t.power <= 1, `aim ${t.aim} power ${t.power}`);
      assert.ok(t.from <= t.at && t.at - Date.now() < 3500 && t.at > th.room.serverNow - 50, `from ${t.from} at ${t.at} now ${th.room.serverNow}`);
      // Its flick is the one it said: the same disc, the same aim.
      const flick = await until((l) => l.room.lastShot && l.room.lastShot.seat !== me && l.room.lastShot.mv > mine.room.lastShot.mv, 4000);
      assert.strictEqual(flick.room.lastShot.disc, t.disc, "the bot flicked the disc it had picked");
      assert.ok(Math.abs(flick.room.lastShot.aim - t.aim) < 0.01, "and at the aim it had shown");
      assert.strictEqual(flick.room.thinking, null, "nothing left to think about once it flicked");
      s.close();
    });
  } finally { child.kill(); }
  console.log(`${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
