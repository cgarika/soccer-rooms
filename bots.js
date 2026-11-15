/* Table Soccer — the bots: which flick would a bot play from here?

   botFlick(bodies, seat, level, rng) is the whole of a bot's mind. It is pure (all randomness comes from `rng`, so a
   test can seed it) and never decides a result: the one simulation that decides where things really go runs in
   server.js, on the flick. Its practice swings are physics.simulate(..., { light: true }) runs.

     easy    a random own disc with some line to the ball, straight at it; aim error +-12 deg, power 60-80 %
     normal  about three candidate shots (the discs nearest the ball, driving it at the goal), scored by a practice
             swing each; aim error +-5 deg
     hard    a fan of candidates (every own disc, five aim points at the goal, two banked off a side wall, three
             powers), each simulated, scored goal / ball toward goal / own-goal risk; aim error +-1.5 deg

   The search runs on a small pool of worker threads (bot-worker.js), as Mini Golf's does, so a burst of bot turns never
   holds the event loop. If the pool is off (BOT_WORKERS=0), a worker dies, or an answer is late, the same search runs
   on the main thread instead, so a bot always flicks. */

"use strict";
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { PHYS, simulate } = require("./physics");

const JOB_TIMEOUT_MS = Math.max(50, Number(process.env.BOT_JOB_TIMEOUT_MS || 2000));
const MAX_RESPAWNS = 20;
const LEVELS = ["easy", "normal", "hard"];
const DEG = Math.PI / 180;
const ERR_DEG = { easy: 12, normal: 5, hard: 1.5 };

/* mulberry32: a small seedable generator, for tests. */
function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampPower = (p) => Math.min(1, Math.max(PHYS.MIN_POWER, p));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const ownDiscs = (seat) => [0, 1, 2, 3, 4].map((k) => seat * 5 + k);

/* Is the straight lane from disc d to the ball free of other discs (a disc is 4 wide; the lane is as wide as one)? */
function hasLine(bodies, d, ball) {
  const [dx, dy] = bodies[d], [bx, by] = bodies[ball];
  const vx = bx - dx, vy = by - dy, l2 = vx * vx + vy * vy;
  if (l2 < 1e-6) return false;
  for (let o = 0; o < 10; o++) {
    if (o === d) continue;
    const t = ((bodies[o][0] - dx) * vx + (bodies[o][1] - dy) * vy) / l2;
    if (t <= 0 || t >= 1) continue;
    const px = dx + t * vx - bodies[o][0], py = dy + t * vy - bodies[o][1];
    if (Math.hypot(px, py) < 2 * PHYS.DISC_R) return false;
  }
  return true;
}

/* Power that rolls a disc about `d` units on an open floor (about, since the table is not open). */
function powerFor(d) {
  return clampPower(d / 112);
}

/* The aim of disc `d` that drives the ball at point T: strike the ball on the side away from T. */
function ghostAim(bodies, d, T) {
  const [dx, dy] = bodies[d], [bx, by] = bodies[10];
  let ux = T[0] - bx, uy = T[1] - by;
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul; uy /= ul;
  const gap = PHYS.DISC_R + PHYS.BALL_R;
  const gx = bx - ux * gap, gy = by - uy * gap;
  return { aim: Math.atan2(gy - dy, gx - dx), reach: dist(dx, dy, gx, gy) };
}

/* How good a practice swing's end is for `seat`, higher is better. */
function score(r, seat) {
  if (r.goalFor === seat) return 10000;
  if (r.goalFor === 1 - seat) return -10000;
  const [bx, by] = r.end[10];
  const progress = seat === 0 ? by : PHYS.L - by;            // how far up the pitch the ball lies, 0..100
  let s = progress * 2 - Math.abs(bx - PHYS.W / 2) * 0.3;
  const home = PHYS.L - progress;                            // the ball's distance from my own goal line
  if (home < 22) s -= (22 - home) * 6;                       // own-goal risk
  if (progress > 80) s += (progress - 80) * 3;               // close to theirs
  return s;
}

function targets(seat, hard) {
  const gy = seat === 0 ? PHYS.L + 1 : -1;                   // a touch past the line
  const t = [[30, gy], [24.5, gy], [35.5, gy]];
  if (hard) t.push([23, gy], [26.5, gy], [28, gy], [32, gy], [33.5, gy], [37, gy]);
  return t;
}
function banks(seat) {
  const gy = seat === 0 ? PHYS.L + 1 : -1;
  return [[-30, gy], [90, gy]];                              // the goal mirrored in each side wall
}

function candidatesFor(bodies, d, tgts, powers) {
  const out = [];
  for (const T of tgts) {
    const g = ghostAim(bodies, d, T);
    for (const f of powers) out.push({ disc: d, aim: g.aim, power: clampPower(f === "auto" ? powerFor(g.reach + 40) : f) });
  }
  return out;
}

function rate(bodies, seat, c) {
  const r = simulate(bodies, c.disc, c.aim, c.power, { light: true });
  return score(r, seat);
}

/* The bot's choice: { disc, aim, power } (aim in radians in the absolute frame, power 0..1). */
function botFlick(bodies, seat, level, rng) {
  rng = rng || Math.random;
  level = LEVELS.includes(level) ? level : "normal";
  const mine = ownDiscs(seat);
  const noise = (deg) => (rng() * 2 - 1) * deg * DEG;
  let pick;

  if (level === "easy") {
    const lined = mine.filter((d) => hasLine(bodies, d, 10));
    const pool = lined.length ? lined : mine;
    const d = pool[Math.floor(rng() * pool.length) % pool.length];
    const aim = Math.atan2(bodies[10][1] - bodies[d][1], bodies[10][0] - bodies[d][0]);
    pick = { disc: d, aim, power: 0.6 + rng() * 0.2 };
  } else {
    const byDist = mine.slice().sort((a, b) => dist(bodies[a][0], bodies[a][1], bodies[10][0], bodies[10][1]) - dist(bodies[b][0], bodies[b][1], bodies[10][0], bodies[10][1]));
    let cands = [];
    if (level === "normal") {
      // three candidates: the discs nearest the ball (with a line first), each driving it at the middle of the goal
      const lined = byDist.filter((d) => hasLine(bodies, d, 10)), rest = byDist.filter((d) => !lined.includes(d));
      for (const d of lined.concat(rest).slice(0, 3)) cands.push(...candidatesFor(bodies, d, [[30, seat === 0 ? PHYS.L + 1 : -1]], ["auto"]));
    } else {
      for (const d of mine) cands.push(...candidatesFor(bodies, d, targets(seat, true).concat(banks(seat)), [0.5, 0.7, 0.85, 1]));
    }
    let best = null, bestS = -Infinity;
    const scored = [];
    for (const c of cands) {
      const s = rate(bodies, seat, c) + rng() * 0.01;       // a hair of noise breaks ties between equal swings
      scored.push({ c, s });
      if (s > bestS) { bestS = s; best = c; }
    }
    if (level === "hard" && scored.length) {
      // refine: the best few, nudged a degree or two each way
      scored.sort((a, b) => b.s - a.s);
      for (const { c } of scored.slice(0, 3)) for (const off of [-2, -1, 1, 2]) {
        const n = { disc: c.disc, aim: c.aim + off * DEG, power: c.power };
        const s = rate(bodies, seat, n) + rng() * 0.01;
        scored.push({ c: n, s });
        if (s > bestS) { bestS = s; best = n; }
      }
      // among the shots that score, keep the one that still scores when the aim is a degree and a half out either way
      // (the bot's own aim error), so its error does not undo a shot that only just fits
      scored.sort((a, b) => b.s - a.s);
      let bestRobust = -1;
      for (const { c, s } of scored.slice(0, 14)) {
        if (s < 5000) break;
        let ok = 0;
        for (const off of [-ERR_DEG.hard, ERR_DEG.hard]) if (rate(bodies, seat, { disc: c.disc, aim: c.aim + off * DEG, power: c.power }) >= 5000) ok++;
        if (ok > bestRobust) { bestRobust = ok; best = c; if (ok === 2) break; }
      }
    }
    pick = best || { disc: byDist[0], aim: ghostAim(bodies, byDist[0], [30, 50]).aim, power: 0.7 };
  }
  return { disc: pick.disc, aim: pick.aim + noise(ERR_DEG[level]), power: clampPower(pick.power) };
}

function defaultWorkers() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

/* The same search, here and now. q: { bodies, seat, level, seed? } */
function thinkHere(q) {
  try { return botFlick(q.bodies, q.seat, q.level, q.seed != null ? seeded(q.seed) : Math.random); }
  catch (e) {
    // Never throw into the server: a plain forward flick with an own disc is better than no flick.
    const seat = q && q.seat === 1 ? 1 : 0;
    return { disc: seat * 5 + 3, aim: seat === 0 ? Math.PI / 2 : -Math.PI / 2, power: 0.6 };
  }
}

const validFlick = (m) => m && Number.isInteger(m.disc) && m.disc >= 0 && m.disc <= 9 && Number.isFinite(m.aim) && Number.isFinite(m.power);

class BotPool {
  constructor(n, opts = {}) {
    this.size = Math.max(0, n | 0);
    this.timeoutMs = opts.timeoutMs || JOB_TIMEOUT_MS;
    this.workers = [];
    this.jobs = new Map();
    this.seq = 0;
    this.respawns = 0;
    this.stats = { posted: 0, answered: 0, local: 0, late: 0, failed: 0 };
    for (let i = 0; i < this.size; i++) this.spawn(i);
  }

  spawn(i) {
    let w;
    try { w = new Worker(path.join(__dirname, "bot-worker.js")); }
    catch (e) { this.workers[i] = null; return; }
    w.unref();                               // a pool never keeps the process alive
    w.pending = 0;
    w.on("message", (m) => {
      const job = m && this.jobs.get(m.id);
      if (!job) return;                      // answered already (it was late and ran here)
      this.jobs.delete(m.id);
      clearTimeout(job.timer);
      w.pending = Math.max(0, w.pending - 1);
      if (m.error || !validFlick(m)) { this.stats.failed++; this.stats.local++; job.resolve(thinkHere(job.q)); return; }
      this.stats.answered++;
      job.resolve({ disc: m.disc, aim: m.aim, power: m.power });
    });
    const lost = () => this.lost(w, i);
    w.on("error", lost);
    w.on("exit", lost);
    this.workers[i] = w;
  }

  /* A worker that died hands its questions back to the main thread, and is replaced. */
  lost(w, i) {
    if (this.workers[i] !== w) return;
    this.workers[i] = null;
    for (const [id, job] of this.jobs) {
      if (job.worker !== w) continue;
      this.jobs.delete(id);
      clearTimeout(job.timer);
      this.stats.failed++; this.stats.local++;
      job.resolve(thinkHere(job.q));
    }
    if (!this.closed && this.respawns < MAX_RESPAWNS) { this.respawns++; this.spawn(i); }
  }

  /* q: { bodies, seat, level, seed? }  ->  Promise<{ disc, aim, power }> */
  think(q) {
    let best = null;
    for (const w of this.workers) if (w && (!best || w.pending < best.pending)) best = w;
    if (!best) { this.stats.local++; return Promise.resolve(thinkHere(q)); }
    return new Promise((resolve) => {
      const id = ++this.seq;
      const job = { q, resolve, worker: best, timer: null };
      job.timer = setTimeout(() => {
        if (!this.jobs.has(id)) return;
        this.jobs.delete(id);
        best.pending = Math.max(0, best.pending - 1);
        this.stats.late++; this.stats.local++;
        resolve(thinkHere(q));
      }, this.timeoutMs);
      job.timer.unref();
      this.jobs.set(id, job);
      best.pending++;
      this.stats.posted++;
      best.postMessage({ id, bodies: q.bodies, seat: q.seat, level: q.level, seed: q.seed });
    });
  }

  live() { return this.workers.filter(Boolean).length; }

  close() {
    this.closed = true;
    for (const w of this.workers) if (w) w.terminate();
    this.workers = [];
  }
}

function createPool(n, opts) {
  const want = n != null ? n
    : process.env.BOT_WORKERS != null && process.env.BOT_WORKERS !== "" ? Math.min(16, Number(process.env.BOT_WORKERS) | 0)
    : defaultWorkers();
  return new BotPool(want, opts);
}

module.exports = { createPool, BotPool, botFlick, thinkHere, seeded, hasLine, LEVELS, ERR_DEG, JOB_TIMEOUT_MS };
