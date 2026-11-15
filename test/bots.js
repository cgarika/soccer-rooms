/* Table Soccer — the bots (bots.js).
   Run: node test/bots.js

   Proves: every level returns a legal flick (an own disc, a finite aim, power 0.05..1) from any position on either
   side; the same seed gives the same flick; easy goes at the ball with a small error and 60-80 % power; hard scores
   from a set-up position in most seeds (and beats normal and easy at it); a whole bot-vs-bot match finishes; the pool
   answers with real flicks (equal to the main thread's for a seed); with no workers the main thread thinks; a worker
   that dies, or never answers, never leaves a bot without a flick. */

"use strict";
const { performance } = require("perf_hooks");
const { PHYS, simulate, formation } = require("../physics");
const { createPool, botFlick, thinkHere, seeded, LEVELS, ERR_DEG } = require("../bots");

let failures = 0, checks = 0;
const check = (ok, what, extra) => { checks++; if (!ok) { failures++; console.log("  FAIL: " + what + (extra ? "  " + extra : "")); } };
const section = (n) => console.log("\n" + n);
const legal = (f, seat) => f && Number.isInteger(f.disc) && f.disc >= seat * 5 && f.disc < seat * 5 + 5
  && Number.isFinite(f.aim) && Number.isFinite(f.power) && f.power >= PHYS.MIN_POWER && f.power <= 1;
const DEG = 180 / Math.PI;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };

/* A layout with a clear lane: seat `seat`'s disc 3 (or 8) behind the ball, which has the open goal in front of it. */
function setUp(seat, seed) {
  const r = seeded(seed * 7919 + 13);
  const park = [[6, 6], [54, 6], [6, 94], [54, 94], [6, 50], [54, 50], [8, 70], [52, 30], [8, 30], [52, 70]];
  const b = park.map((p) => p.slice());
  const bx = 22 + r() * 16, by = 62 + r() * 8;                // the ball in the attacking half (seat 0's frame)
  const dx = bx + (r() - 0.5) * 14, dy = by - 12 - r() * 8;   // a disc behind it
  const disc = seat * 5 + 3;
  const mirror = (x, y) => (seat === 0 ? [x, y] : [60 - x, 100 - y]);
  b[disc] = mirror(dx, dy);
  // the other side has a defender in the way, a little off the middle of the goal
  b[seat === 0 ? 5 : 0] = mirror(33 + (seed % 3) * 2, 83);
  b.push(mirror(bx, by));
  return { bodies: b, disc };
}

(async () => {
  section("every level returns a legal flick, from any position, for either seat");
  {
    const r = seeded(99);
    const scatter = () => {
      const b = [];
      while (b.length < 11) {
        const i = b.length, rr = i === 10 ? 2.2 : 4;
        const x = rr + r() * (60 - 2 * rr), y = rr + r() * (100 - 2 * rr);
        if (b.every((q, j) => Math.hypot(q[0] - x, q[1] - y) > rr + (j === 10 ? 2.2 : 4) + 0.3)) b.push([x, y]);
      }
      return b;
    };
    let n = 0;
    for (const level of LEVELS) for (let seat = 0; seat < 2; seat++) {
      for (let k = 0; k < (level === "hard" ? 15 : 40); k++) {
        const bodies = k === 0 ? formation(seat) : scatter();
        const f = botFlick(bodies, seat, level, seeded(k + 1));
        n++;
        check(legal(f, seat), `${level} seat ${seat}: not a legal flick`, JSON.stringify(f));
        // and the server's simulate() takes it
        try { simulate(bodies, f.disc, f.aim, f.power, { light: true }); } catch (e) { check(false, `${level}: simulate rejected the flick`, String(e)); }
      }
    }
    for (const bad of [undefined, "wild", 7]) check(legal(botFlick(formation(0), 0, bad, seeded(1)), 0), "an unknown level should play as normal", String(bad));
    console.log(`  ${n} flicks, all legal; unknown levels play as normal`);
  }

  section("seedable: the same seed is the same flick");
  {
    const bodies = formation(1);
    for (const level of LEVELS) {
      const a = JSON.stringify(botFlick(bodies, 1, level, seeded(5))), b = JSON.stringify(botFlick(bodies, 1, level, seeded(5))), c = JSON.stringify(botFlick(bodies, 1, level, seeded(6)));
      check(a === b, `${level}: one seed gave two flicks`);
      check(a !== c || level === "hard", `${level}: two seeds gave the same flick`);
    }
    console.log("  deterministic under a seed, varied across seeds");
  }

  section("easy goes at the ball, softly");
  {
    let n = 0, maxErr = 0, minP = 1, maxP = 0, line = 0;
    for (let k = 0; k < 120; k++) {
      const seat = k % 2;
      const { bodies } = setUp(seat, k);
      const f = botFlick(bodies, seat, "easy", seeded(k + 3));
      const want = Math.atan2(bodies[10][1] - bodies[f.disc][1], bodies[10][0] - bodies[f.disc][0]);
      maxErr = Math.max(maxErr, angDiff(f.aim, want) * DEG);
      minP = Math.min(minP, f.power); maxP = Math.max(maxP, f.power);
      n++;
    }
    check(maxErr <= ERR_DEG.easy + 1e-6, "easy's aim error should be within 12 degrees", maxErr.toFixed(2));
    check(minP >= 0.6 - 1e-9 && maxP <= 0.8 + 1e-9, "easy's power should be 60-80 %", `${minP.toFixed(2)}..${maxP.toFixed(2)}`);
    console.log(`  ${n} flicks: worst aim error ${maxErr.toFixed(1)} deg, power ${minP.toFixed(2)}..${maxP.toFixed(2)}`);
    void line;
  }

  section("hard scores from a set-up position in most seeds");
  {
    const rate = {};
    const SEEDS = 40;
    for (const level of ["easy", "normal", "hard"]) {
      let goals = 0, own = 0, t = performance.now();
      for (let k = 0; k < SEEDS; k++) {
        const seat = k % 2;
        const { bodies } = setUp(seat, k);
        const f = botFlick(bodies, seat, level, seeded(1000 + k));
        const o = simulate(bodies, f.disc, f.aim, f.power);
        if (o.goalFor === seat) goals++; else if (o.goalFor === 1 - seat) own++;
      }
      rate[level] = goals / SEEDS;
      console.log(`  ${level}: ${goals}/${SEEDS} goals, ${own} own goals, ${((performance.now() - t) / SEEDS).toFixed(0)} ms a flick`);
    }
    check(rate.hard >= 0.75, "hard should score from a set-up position in most seeds", `${rate.hard}`);
    check(rate.hard > rate.easy, "hard should score more often than easy", JSON.stringify(rate));
    check(rate.hard >= rate.normal, "hard should score at least as often as normal", JSON.stringify(rate));
  }

  section("a whole bot-vs-bot match finishes (hard against easy, headless)");
  {
    const bodiesOf = (k) => formation(k);
    let bodies = bodiesOf(0), turn = 0, score = [0, 0], flicks = 0, goals = 3, own = 0;
    const lvl = ["hard", "easy"];
    const r = seeded(31337);
    while (score[0] < goals && score[1] < goals && flicks < 400) {
      const f = botFlick(bodies, turn, lvl[turn], r);
      check(legal(f, turn), "illegal flick mid-match", JSON.stringify(f));
      const o = simulate(bodies, f.disc, f.aim, f.power);
      flicks++;
      if (o.goalFor != null) { score[o.goalFor]++; if (o.goalFor !== turn) own++; bodies = bodiesOf(1 - o.goalFor); turn = 1 - o.goalFor; }
      else { bodies = o.end; turn = 1 - turn; }
    }
    check(score[0] >= goals || score[1] >= goals, "the match did not finish", `${flicks} flicks, ${score}`);
    console.log(`  first to ${goals}: ${score[0]}-${score[1]} after ${flicks} flicks (hard ${score[0] > score[1] ? "won" : "lost"}), ${own} own goals`);
  }

  section("a pool answers with a real flick");
  {
    const pool = createPool(2, { timeoutMs: 30000 });   // 24 questions, a third of them hard (0.4 s each): well over the default 2 s in a queue
    check(pool.live() === 2, "two workers did not start", String(pool.live()));
    const asks = [];
    for (let k = 0; k < 24; k++) {
      const seat = k % 2, level = LEVELS[k % 3];
      asks.push(pool.think({ bodies: formation(seat), seat, level, seed: 40 + k }).then((s) => ({ s, seat, level, k })));
    }
    const out = await Promise.all(asks);
    for (const { s, seat, level, k } of out) {
      check(legal(s, seat), `${level}: the pool's answer is not a flick`, JSON.stringify(s));
      const here = thinkHere({ bodies: formation(seat), seat, level, seed: 40 + k });
      check(JSON.stringify(here) === JSON.stringify(s), `${level}: the worker and the main thread disagree for one seed`, JSON.stringify([s, here]));
    }
    check(pool.stats.answered === asks.length && pool.stats.local === 0, "the workers did not answer everything", JSON.stringify(pool.stats));
    pool.close();
    console.log(`  ${out.length} questions, all answered by the workers, equal to the main thread's for the seed`);
  }

  section("no workers: the main thread thinks");
  {
    const pool = createPool(0);
    const s = await pool.think({ bodies: formation(0), seat: 0, level: "hard" });
    check(legal(s, 0) && pool.stats.local === 1, "BOT_WORKERS=0 did not think locally", JSON.stringify(pool.stats));
    check(legal(thinkHere({ bodies: formation(1), seat: 1, level: "normal", seed: 3 }), 1), "thinkHere is not a flick");
    console.log("  answered here");
  }

  section("a worker that dies hands its questions back");
  {
    const pool = createPool(1);
    const asks = [];
    for (let k = 0; k < 20; k++) asks.push(pool.think({ bodies: formation(k % 2), seat: k % 2, level: "normal" }));
    pool.workers[0].terminate();
    const out = await Promise.all(asks);
    check(out.every((s, k) => legal(s, k % 2)), "a question was lost with its worker");
    await new Promise((r) => setTimeout(r, 300));
    check(pool.live() === 1, "the dead worker was not replaced", String(pool.live()));
    const again = await pool.think({ bodies: formation(0), seat: 0, level: "easy" });
    check(legal(again, 0), "the replacement does not answer");
    pool.close();
    console.log(`  20 of 20 answered (${pool.stats.failed} fell back), and a new worker took over`);
  }

  section("a worker that never answers is not waited on forever");
  {
    process.env.BOT_WORKER_TEST_HANG = "1";
    const pool = createPool(1, { timeoutMs: 150 });
    delete process.env.BOT_WORKER_TEST_HANG;
    const t0 = performance.now();
    const s = await pool.think({ bodies: formation(0), seat: 0, level: "hard" });
    const ms = performance.now() - t0;
    check(legal(s, 0), "a hung worker left the bot without a flick");
    check(pool.stats.late === 1 && ms < 1500, "the late answer was not replaced in time", `${ms.toFixed(0)} ms ${JSON.stringify(pool.stats)}`);
    pool.close();
    console.log(`  answered here after ${ms.toFixed(0)} ms`);
  }

  section("a worker given junk answers with an error, and the pool falls back");
  {
    const pool = createPool(1);
    const s = await pool.think({ bodies: [[1, 2]], seat: 0, level: "easy" });   // not 11 bodies: the worker throws inside
    check(legal(s, 0), "junk in should still give a legal flick out", JSON.stringify(s));
    pool.close();
  }

  console.log(failures === 0 ? `\nbots: all good (${checks} checks)\n` : `\nbots: ${failures} failure(s)\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
