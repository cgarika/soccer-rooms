/* Table Soccer — the physics. The server owns it: a client sends a disc, an aim and a power, simulate() runs every
   body until it all stops (or a goal, or 9 s) and returns the whole path, which the app plays back.

   Deterministic: plain JS numbers, no Math.random, a fixed 120 Hz step (each split into SUB collision substeps so
   nothing tunnels), frames sampled at 60 Hz. The same input is the same output, bit for bit.

   Bodies are 11 [x, y] pairs: discs 0-4 (seat 0), 5-9 (seat 1), then the ball (10). The pitch is x 0..60, y 0..100;
   seat 0 defends y=0 and attacks y=100. Goal mouths x 21..39 on both end lines, each a box 6 deep behind its line.
   Frames are [ball x, ball y, disc 0 x, disc 0 y, ... disc 9 x, disc 9 y] (the ball first, as in PROTOCOL). */
"use strict";

const PHYS = {
  W: 60, L: 100, GOAL_X0: 21, GOAL_X1: 39, GOAL_DEPTH: 6,
  DISC_R: 4.0, BALL_R: 2.2, POST_R: 0.9,
  DISC_M: 5, BALL_M: 1,                    // disc : ball = 5 : 1
  STEP_HZ: 120, SUB: 4, FRAME_HZ: 60, MAX_S: 9,
  STOP_SPEED: 0.25,                        // below this (u/s) a body snaps to a stop
  DISC_DAMP: 0.992, BALL_DAMP: 0.990,       // linear damping per 120 Hz step
  DISC_FRIC: 10, BALL_FRIC: 5,             // plus a constant rolling friction (u/s^2) so things STOP
  E_DISC_WALL: 0.75, E_BALL_WALL: 0.85, E_DISC_DISC: 0.90, E_DISC_BALL: 0.90, E_POST: 0.80,
  VMAX: 133,                             // a full flick, u/s (power 1); power 0..1 is linear
  MIN_POWER: 0.05,
  GOAL_TAIL_FRAMES: 30,                    // after a goal the net is shown for half a second more
  GOAL_NET_DAMP: 0.8,                      // the net eats the ball once it is over the line (per step)
  NEAR_GAP: 2, SAVE_DIST: 18,
  EVENT_MIN_SPEED: 6,                      // impacts slower than this (u/s) make no event
  EVENT_REF_SPEED: 260,                    // an impact at this speed has s = 1
};

const N = 11, BALL = 10;
const R = [];                              // radii and masses by body
const M = [];
for (let i = 0; i < 10; i++) { R.push(PHYS.DISC_R); M.push(PHYS.DISC_M); }
R.push(PHYS.BALL_R); M.push(PHYS.BALL_M);

/* The walls: segments a body bounces off. Side walls, the end walls either side of each mouth, and each goal box
   (two sides and a back). The posts are circles at the mouth's four corners. */
const { W, L, GOAL_X0: GX0, GOAL_X1: GX1, GOAL_DEPTH: GD } = PHYS;
const SEGS = [
  [0, 0, 0, L], [W, 0, W, L],
  [0, 0, GX0, 0], [GX1, 0, W, 0], [0, L, GX0, L], [GX1, L, W, L],
  [GX0, 0, GX0, -GD], [GX0, -GD, GX1, -GD], [GX1, -GD, GX1, 0],
  [GX0, L, GX0, L + GD], [GX0, L + GD, GX1, L + GD], [GX1, L + GD, GX1, L],
].map(([ax, ay, bx, by]) => ({ ax, ay, dx: bx - ax, dy: by - ay, l2: (bx - ax) * (bx - ax) + (by - ay) * (by - ay) }));
const POSTS = [[GX0, 0], [GX1, 0], [GX0, L], [GX1, L]];     // posts 0,1 are on the y=0 line (seat 1 attacks it)

/* Seat 0's formation; seat 1's is the point mirror. The kicking side's front pair steps up for the kick-off. */
const FORM0 = [[30, 9], [14, 26], [46, 26], [21, 41], [39, 41]];
const KICK0 = [[24, 45], [36, 45]];
function formation(kickoffSeat) {
  const out = [];
  for (let i = 0; i < 5; i++) out.push([FORM0[i][0], FORM0[i][1]]);
  for (let i = 0; i < 5; i++) out.push([W - FORM0[i][0], L - FORM0[i][1]]);
  out.push([30, 50]);
  if (kickoffSeat === 0) { out[3] = [KICK0[0][0], KICK0[0][1]]; out[4] = [KICK0[1][0], KICK0[1][1]]; }
  else if (kickoffSeat === 1) { out[8] = [W - KICK0[0][0], L - KICK0[0][1]]; out[9] = [W - KICK0[1][0], L - KICK0[1][1]]; }
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;

/* How fast a flick of this power starts a disc, u/s. */
function flickSpeed(power) {
  const p = Math.min(1, Math.max(PHYS.MIN_POWER, Number(power)));
  return PHYS.VMAX * p;
}

/* How far a body launched at `speed` would roll on an open floor (no walls, nothing in the way). */
function freeTravel(speed, ball) {
  const d = ball ? PHYS.BALL_DAMP : PHYS.DISC_DAMP, f = ball ? PHYS.BALL_FRIC : PHYS.DISC_FRIC, dt = 1 / PHYS.STEP_HZ;
  let v = speed, dist = 0, t = 0;
  while (v >= PHYS.STOP_SPEED && t < PHYS.MAX_S * PHYS.STEP_HZ) {
    dist += v * dt;
    v = v * d - f * dt;
    t++;
  }
  return { dist, seconds: t * dt };
}

/* opts: { light: true } skips frames and events (a bot's practice swing); { onStep(sim) } is called after every
   120 Hz step (the tests read energy and positions from it); gear (gear.js soccerEffects): { speed } multiplies the flick's top speed, { keepers: [k0, k1] } the radius of seat 0's keeper (disc 0)
   and seat 1's (disc 5): none, or 1s, is exactly the base. */
function simulate(bodies, disc, aim, power, opts) {
  opts = opts || {};
  const keepers = Array.isArray(opts.keepers) ? opts.keepers : null;
  const Rad = keepers && (keepers[0] !== 1 || keepers[1] !== 1) ? R.map((r, i) => (i === 0 && keepers[0] > 0 ? r * keepers[0] : i === 5 && keepers[1] > 0 ? r * keepers[1] : r)) : R;
  if (!Array.isArray(bodies) || bodies.length !== N) throw new RangeError("bodies must be 11 pairs");
  if (!Number.isInteger(disc) || disc < 0 || disc > 9) throw new RangeError("disc must be 0..9");
  if (!Number.isFinite(aim) || !Number.isFinite(power)) throw new RangeError("aim and power must be numbers");
  const light = !!opts.light;
  const x = new Array(N), y = new Array(N), vx = new Array(N).fill(0), vy = new Array(N).fill(0);
  for (let i = 0; i < N; i++) { x[i] = Number(bodies[i][0]); y[i] = Number(bodies[i][1]); }
  const sp = flickSpeed(power) * (opts.speed > 0 ? opts.speed : 1);
  vx[disc] = Math.cos(aim) * sp; vy[disc] = Math.sin(aim) * sp;

  const SUB = PHYS.SUB, h = 1 / (PHYS.STEP_HZ * SUB);
  const maxSteps = PHYS.MAX_S * PHYS.STEP_HZ;
  const frames = [], events = [];
  const snap = () => {
    const f = [r2(x[BALL]), r2(y[BALL])];
    for (let i = 0; i < 10; i++) f.push(r2(x[i]), r2(y[i]));
    frames.push(f);
  };
  if (!light) snap();

  let step = 0, result = "timeout", goalFor = null, goalStep = -1;
  const frameOf = () => Math.ceil(step / 2);
  const lastPostNear = [-99, -99, -99, -99];
  const inBox = [false, false];             // ball centre over an end line but not far enough: [y<0 box, y>L box]
  const ev = (k, a, b, s) => {
    if (light) return;
    const e = { f: frameOf(), k };
    if (a !== undefined) e.a = a;
    if (b !== undefined) e.b = b;
    if (s !== undefined) e.s = Math.round(Math.min(1, s / PHYS.EVENT_REF_SPEED) * 100) / 100;
    events.push(e);
  };

  // a body against a segment (e: its restitution); returns the speed it hit with, or 0
  function wallHit(i, sg, e) {
    const rr = Rad[i];
    let t = ((x[i] - sg.ax) * sg.dx + (y[i] - sg.ay) * sg.dy) / sg.l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x[i] - (sg.ax + t * sg.dx), py = y[i] - (sg.ay + t * sg.dy);
    const d2 = px * px + py * py;
    if (d2 >= rr * rr) return 0;
    let nx, ny, d = Math.sqrt(d2);
    if (d < 1e-9) { const l = Math.sqrt(sg.l2); nx = -sg.dy / l; ny = sg.dx / l; d = 0; }
    else { nx = px / d; ny = py / d; }
    x[i] += nx * (rr - d); y[i] += ny * (rr - d);
    const vn = vx[i] * nx + vy[i] * ny;
    if (vn >= 0) return 0;
    vx[i] -= (1 + e) * vn * nx; vy[i] -= (1 + e) * vn * ny;
    return -vn;
  }
  function postHit(i, p) {
    const rr = Rad[i] + PHYS.POST_R;
    const px = x[i] - POSTS[p][0], py = y[i] - POSTS[p][1];
    const d2 = px * px + py * py;
    if (d2 >= rr * rr) return 0;
    let nx = 1, ny = 0;
    const d = Math.sqrt(d2);
    if (d > 1e-9) { nx = px / d; ny = py / d; }
    x[i] += nx * (rr - d); y[i] += ny * (rr - d);
    const vn = vx[i] * nx + vy[i] * ny;
    if (vn >= 0) return 0;
    vx[i] -= (1 + PHYS.E_POST) * vn * nx; vy[i] -= (1 + PHYS.E_POST) * vn * ny;
    return -vn;
  }
  function pairHit(i, j, e) {
    const rs = Rad[i] + Rad[j];
    const dx = x[j] - x[i], dy = y[j] - y[i];
    const d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return 0;
    let nx = 1, ny = 0;
    const d = Math.sqrt(d2);
    if (d > 1e-9) { nx = dx / d; ny = dy / d; }
    const ii = 1 / M[i], ij = 1 / M[j], is = ii + ij, push = (rs - d) / is;
    x[i] -= nx * push * ii; y[i] -= ny * push * ii; x[j] += nx * push * ij; y[j] += ny * push * ij;
    const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
    if (vn >= 0) return 0;
    const jm = -(1 + e) * vn / is;
    vx[i] -= jm * ii * nx; vy[i] -= jm * ii * ny; vx[j] += jm * ij * nx; vy[j] += jm * ij * ny;
    return -vn;
  }
  // a last resort for a body shoved through a wall by a pile-up: back to the playable region
  function safety(i) {
    const a = 0.05;
    if (y[i] >= 0 && y[i] <= L) {
      if (x[i] < a) x[i] = a; else if (x[i] > W - a) x[i] = W - a;
    } else {
      if (x[i] < GX0 + a) x[i] = GX0 + a; else if (x[i] > GX1 - a) x[i] = GX1 - a;
      if (y[i] < -GD + a) y[i] = -GD + a; else if (y[i] > L + GD - a) y[i] = L + GD - a;
    }
  }

  /* "save": a disc met a ball that was heading into the mouth of the goal the disc's side defends, within SAVE_DIST of
     the line, and it is no longer heading in (or has lost over half its speed). pv: the ball before the impact. */
  function checkSave(d, s, pv) {
    const defends = d < 5 ? 0 : 1;           // seat 0 defends y=0 (the ball heading to -y)
    const toward = defends === 0 ? pv.vy < -1 : pv.vy > 1;
    if (!toward) return;
    const line = defends === 0 ? 0 : L;
    if (Math.abs(pv.y - line) > PHYS.SAVE_DIST) return;
    const t = (line - pv.y) / pv.vy;
    const xAt = pv.x + pv.vx * t;
    if (xAt < GX0 - Rad[BALL] || xAt > GX1 + Rad[BALL]) return;
    const nowToward = defends === 0 ? vy[BALL] < -1 : vy[BALL] > 1;
    const spd0 = Math.sqrt(pv.vx * pv.vx + pv.vy * pv.vy), spd1 = Math.sqrt(vx[BALL] * vx[BALL] + vy[BALL] * vy[BALL]);
    if (nowToward && spd1 > 0.5 * spd0) return;
    ev("save", d, BALL, s);
  }

  function substep() {
    for (let i = 0; i < N; i++) { x[i] += vx[i] * h; y[i] += vy[i] * h; }
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        if (vx[i] === 0 && vy[i] === 0 && vx[j] === 0 && vy[j] === 0) continue;   // two bodies at rest cannot meet
        const ball = j === BALL;
        const pv = ball && !light ? { x: x[BALL], y: y[BALL], vx: vx[BALL], vy: vy[BALL] } : null;
        const s = pairHit(i, j, ball ? PHYS.E_DISC_BALL : PHYS.E_DISC_DISC);
        if (s > PHYS.EVENT_MIN_SPEED && !light) {
          if (ball) { ev("kick", i, BALL, s); checkSave(i, s, pv); }
          else ev("hit", i, j, s);
        }
      }
      for (let i = 0; i < N; i++) {
        if (vx[i] === 0 && vy[i] === 0) continue;   // a body at rest is not against anything new
        const e = i === BALL ? PHYS.E_BALL_WALL : PHYS.E_DISC_WALL;
        let hit = 0;
        for (let k = 0; k < SEGS.length; k++) { const s = wallHit(i, SEGS[k], e); if (s > hit) hit = s; }
        if (hit > PHYS.EVENT_MIN_SPEED) ev("wall", i, undefined, hit);
        for (let p = 0; p < 4; p++) {
          const s = postHit(i, p);
          if (s > PHYS.EVENT_MIN_SPEED) { ev("post", i, p, s); if (i === BALL) lastPostNear[p] = frameOf(); }
        }
        safety(i);
      }
    }
  }

  const stopSq = PHYS.STOP_SPEED * PHYS.STOP_SPEED;
  const dt = 1 / PHYS.STEP_HZ;
  const ballIn = (side) => (side === 0 ? y[BALL] < -Rad[BALL] : y[BALL] > L + Rad[BALL]);
  let ended = false;

  while (step < maxSteps) {
    step++;
    for (let s = 0; s < SUB; s++) substep();
    // damping and friction, once per 120 Hz step
    let moving = false;
    for (let i = 0; i < N; i++) {
      const ball = i === BALL;
      let d = ball ? PHYS.BALL_DAMP : PHYS.DISC_DAMP;
      if (goalStep >= 0 && ball) d = PHYS.GOAL_NET_DAMP;
      const f = (ball ? PHYS.BALL_FRIC : PHYS.DISC_FRIC) * dt;
      let sq = vx[i] * vx[i] + vy[i] * vy[i];
      if (sq > 0) {
        const spd = Math.sqrt(sq), ns = spd * d - f;
        if (ns <= 0) { vx[i] = 0; vy[i] = 0; sq = 0; }
        else { const k = ns / spd; vx[i] *= k; vy[i] *= k; sq = ns * ns; }
      }
      if (sq < stopSq) { vx[i] = 0; vy[i] = 0; } else moving = true;
    }
    // goal: the ball's centre fully over the line (more than its radius), inside the mouth
    if (goalStep < 0 && x[BALL] > GX0 && x[BALL] < GX1) {
      if (ballIn(0)) goalFor = 1; else if (ballIn(1)) goalFor = 0;
      if (goalFor !== null) { goalStep = step; result = "goal"; ev("goal", goalFor); }
    }
    if (!light && goalStep < 0) {
      // near misses: a ball at speed grazing a post; a ball over its line but not fully, coming back out
      const bs = Math.sqrt(vx[BALL] * vx[BALL] + vy[BALL] * vy[BALL]);
      if (bs > 25) for (let p = 0; p < 4; p++) {
        const gap = Math.sqrt((x[BALL] - POSTS[p][0]) ** 2 + (y[BALL] - POSTS[p][1]) ** 2) - Rad[BALL] - PHYS.POST_R;
        if (gap < PHYS.NEAR_GAP && frameOf() - lastPostNear[p] > 30) { lastPostNear[p] = frameOf(); ev("near", p < 2 ? 1 : 0); }
      }
      for (let side = 0; side < 2; side++) {
        const over = side === 0 ? y[BALL] < 0 : y[BALL] > L;
        if (over) inBox[side] = true;
        else if (inBox[side]) { inBox[side] = false; ev("near", side === 0 ? 1 : 0); }
      }
    }
    if (opts.onStep) opts.onStep({ step, x, y, vx, vy, m: M, goalStep });
    if (!light && (step & 1) === 0) snap();
    if (goalStep >= 0) {
      if (step - goalStep >= PHYS.GOAL_TAIL_FRAMES * 2) { ended = true; break; }
    } else if (!moving) { result = "stop"; ended = true; break; }
  }
  if (!ended && goalStep < 0) result = "timeout";
  if (!light && (step & 1) === 1) snap();     // the last frame is always where everything ends
  const end = [];
  for (let i = 0; i < N; i++) end.push([r2(x[i]), r2(y[i])]);
  const out = { frames, events, result, end, steps: step };
  if (goalFor !== null) out.goalFor = goalFor;
  return out;
}

/* The tail of a flick (pacing round 1, 2026-11-01). A flick plays back until every body has stopped, and the last second or
   more of that is things creeping: the phone's log had a bot waiting for it each time. From the frame after which no body moves
   faster than vStill (u/s) to the end, only every `keep`th frame is kept, so the app (which plays the frames at 60 Hz and
   blends between them, and fires an event when the playback reaches its frame) shows the creep at `keep` times the speed, ends
   in the very same positions (the last frame is always kept) and the events that fell in it fire at the frame that is now
   where they happened. A goal's flick is left whole (the net is shown, then the goal pause is counted from its end).
   shot: simulate()'s answer; returns the same shape, frames and events thinned. */
function compressTail(shot, vStill = 15, keep = 3) {
  const f = shot && shot.frames;
  if (!f || f.length < 40 || shot.result === "goal" || keep < 2) return shot;
  const speedAt = (k) => { let m = 0; for (let i = 0; i < 2 * N; i += 2) { const d = Math.hypot(f[k][i] - f[k - 1][i], f[k][i + 1] - f[k - 1][i + 1]) * PHYS.FRAME_HZ; if (d > m) m = d; } return m; };
  let still = f.length - 1;
  while (still > 0 && speedAt(still) < vStill) still--;   // the last frame that is still moving fast
  if (f.length - 1 - still < 20) return shot;               // under a third of a second of tail: leave it
  const frames = f.slice(0, still + 1);
  for (let k = still + keep; k < f.length - 1; k += keep) frames.push(f[k]);
  frames.push(f[f.length - 1]);
  const at = (old) => (old <= still ? old : Math.min(frames.length - 1, still + Math.ceil((old - still) / keep)));
  const events = shot.events.map((e) => (e.f > still ? Object.assign({}, e, { f: at(e.f) }) : e));
  return Object.assign({}, shot, { frames, events });
}

module.exports = { PHYS, simulate, compressTail, formation, flickSpeed, freeTravel, SEGS, POSTS, N, BALL, R, M };
