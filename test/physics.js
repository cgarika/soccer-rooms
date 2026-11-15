/* Table Soccer — the physics (physics.js), in process.
   Run: node test/physics.js

   Proves: simulate() is deterministic; nothing leaves the pitch or the two goal boxes, at any power, and nothing tunnels
   through a wall or a post; energy never grows; a goal needs the ball's centre fully over the line, inside the mouth
   (a ball on the line is not one); the posts are solid and report which post; the kick-off formation is as PROTOCOL
   says; every body stops; the frames and events have the shape PROTOCOL promises; and the numbers play well (a full
   flick of a lone disc ~110 u, a ball struck from midfield reaches the far goal, a typical turn settles in 2-5 s). */

"use strict";
const { PHYS, simulate, formation, flickSpeed, freeTravel, SEGS, POSTS, R, M } = require("../physics");

let failures = 0, checks = 0;
const check = (ok, what, extra) => { checks++; if (!ok) { failures++; console.log("  FAIL: " + what + (extra ? "  " + extra : "")); } };
const section = (n) => console.log("\n" + n);

/* a small seeded generator for the tests' own randomness (simulate itself uses none) */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const { W, L, GOAL_X0: GX0, GOAL_X1: GX1, GOAL_DEPTH: GD } = PHYS;

/* ten discs parked out of the way (not on the lanes the tests use) plus a ball */
const PARK = [[6, 6], [54, 6], [6, 94], [54, 94], [6, 50], [54, 50], [8, 70], [52, 30], [8, 30], [52, 70]];
const empty = (ball) => PARK.map((p) => p.slice()).concat([ball]);

/* a body's distance to the nearest wall (segments) and post, minus its radius: negative is penetration */
function clearance(i, x, y) {
  let best = Infinity;
  for (const s of SEGS) {
    let t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - (s.ax + t * s.dx), y - (s.ay + t * s.dy)) - R[i]);
  }
  for (const p of POSTS) best = Math.min(best, Math.hypot(x - p[0], y - p[1]) - R[i] - PHYS.POST_R);
  return best;
}
function inside(x, y) {
  const a = 0.02;
  if (y >= 0 && y <= L) return x >= -a && x <= W + a;
  return x >= GX0 - a && x <= GX1 + a && y >= -GD - a && y <= L + GD + a;
}

/* every body, every step: stay in the pitch + goal boxes, never push far into a wall, energy never grows */
function watch(bodies, disc, aim, power) {
  let worstPen = 0, outside = null, maxSpeed = 0, grew = 0, prevE = null, eAtStart = null;
  const out = simulate(bodies, disc, aim, power, {
    onStep: (s) => {
      let e = 0;
      for (let i = 0; i < 11; i++) {
        if (!inside(s.x[i], s.y[i])) outside = outside || { i, x: s.x[i], y: s.y[i], step: s.step };
        worstPen = Math.min(worstPen, clearance(i, s.x[i], s.y[i]));
        const v = Math.hypot(s.vx[i], s.vy[i]);
        maxSpeed = Math.max(maxSpeed, v);
        e += 0.5 * s.m[i] * v * v;
      }
      if (prevE != null && e > prevE * (1 + 1e-9) + 1e-6) grew = Math.max(grew, e - prevE);
      prevE = e;
    },
  });
  return { out, worstPen, outside, maxSpeed, grew };
}

/* ------------------------------------------------------------------ determinism */
section("determinism");
{
  const f = formation(0);
  let same = 0, n = 0;
  const r = rng(11);
  for (let k = 0; k < 40; k++) {
    const d = Math.floor(r() * 5), aim = r() * Math.PI * 2, p = 0.2 + r() * 0.8;
    const a = JSON.stringify(simulate(f, d, aim, p)), b = JSON.stringify(simulate(f, d, aim, p));
    n++; if (a === b) same++;
  }
  check(same === n, "the same flick gave different results", `${same}/${n}`);
  const input = JSON.stringify(f);
  simulate(f, 3, 1.1, 1);
  check(JSON.stringify(f) === input, "simulate changed the bodies it was given");
  const full = simulate(f, 3, 1.2, 0.9), light = simulate(f, 3, 1.2, 0.9, { light: true });
  check(JSON.stringify(full.end) === JSON.stringify(light.end) && full.result === light.result, "a light swing ends somewhere else than the real one");
  check(light.frames.length === 0 && light.events.length === 0, "a light swing carries frames");
  let threw = 0;
  for (const bad of [[f, 10, 0, 1], [f, -1, 0, 1], [f, 1.5, 0, 1], [f, 0, NaN, 1], [f, 0, 0, Infinity], [f.slice(0, 10), 0, 0, 1]]) { try { simulate(...bad); } catch (e) { threw++; } }
  check(threw === 6, "bad arguments did not throw", String(threw));
  console.log(`  ${n} flicks twice over, identical; the light swing agrees with the real one`);
}

/* ------------------------------------------------------------------ formation */
section("the kick-off formation");
{
  const f0 = formation(0), f1 = formation(1), fn = formation(null);
  check(f0.length === 11 && f1.length === 11, "11 bodies");
  check(JSON.stringify(fn.slice(0, 3)) === JSON.stringify([[30, 9], [14, 26], [46, 26]]), "seat 0's back three are (30,9) (14,26) (46,26)");
  check(JSON.stringify(fn[3]) === "[21,41]" && JSON.stringify(fn[4]) === "[39,41]", "seat 0's front pair rests at (21,41) (39,41)");
  check(JSON.stringify(fn[10]) === "[30,50]", "the ball is at (30,50)");
  for (let i = 0; i < 5; i++) check(fn[5 + i][0] === 60 - fn[i][0] && fn[5 + i][1] === 100 - fn[i][1], `disc ${5 + i} is disc ${i} point-mirrored`);
  check(JSON.stringify([f0[3], f0[4]]) === "[[24,45],[36,45]]", "seat 0 kicking off: its front pair steps up to (24,45) (36,45)");
  check(JSON.stringify([f1[8], f1[9]]) === "[[36,55],[24,55]]", "seat 1 kicking off: its front pair steps up (the point mirror)");
  for (const [f, kick] of [[f0, 0], [f1, 1]]) {
    const other = kick === 0 ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
    for (const i of other) check(Math.hypot(f[i][0] - 30, f[i][1] - 50) >= 12, `kick-off ${kick}: the other side's disc ${i} is outside the centre circle`);
    for (let i = 0; i < 11; i++) {
      check(inside(f[i][0], f[i][1]) && clearance(i, f[i][0], f[i][1]) > 0, `kick-off ${kick}: body ${i} is inside the pitch, clear of the walls`);
      for (let j = i + 1; j < 11; j++) check(Math.hypot(f[i][0] - f[j][0], f[i][1] - f[j][1]) >= R[i] + R[j], `kick-off ${kick}: bodies ${i} and ${j} overlap`);
    }
  }
  check(M[0] === 5 && M[10] === 1 && R[0] === 4 && R[10] === 2.2, "ten discs r=4 (mass 5), the ball r=2.2 (mass 1)");
  console.log("  both kick-offs checked: mirror, centre circle, no overlaps");
}

/* ------------------------------------------------------------------ containment, tunnelling, energy */
section("containment, no tunnelling, energy never grows (random flicks, every power, many layouts)");
{
  const r = rng(2026);
  let n = 0, worstPen = 0, worstSpeed = 0, worstGrow = 0, bad = 0, timeouts = 0;
  const layouts = [formation(0), formation(1)];
  const scatter = () => {
    const b = [];
    while (b.length < 11) {
      const i = b.length, x = R[i] + r() * (W - 2 * R[i]), y = R[i] + r() * (L - 2 * R[i]);
      if (b.every((q, j) => Math.hypot(q[0] - x, q[1] - y) > R[i] + R[j] + 0.3)) b.push([x, y]);
    }
    return b;
  };
  for (let k = 0; k < 900; k++) {
    const layout = k < 300 ? layouts[k % 2] : scatter();
    const disc = Math.floor(r() * 10), aim = r() * Math.PI * 2;
    const power = k % 3 === 0 ? 1 : r();                  // a third of them at full power
    const w = watch(layout, disc, aim, power);
    n++;
    worstPen = Math.min(worstPen, w.worstPen); worstSpeed = Math.max(worstSpeed, w.maxSpeed); worstGrow = Math.max(worstGrow, w.grew);
    if (w.outside) { bad++; if (bad < 4) check(false, "a body left the pitch", JSON.stringify(w.outside)); }
    if (w.out.result === "timeout") timeouts++;
  }
  check(bad === 0, `${bad} flicks put a body outside the pitch and goal boxes`);
  check(worstPen > -0.8, "a body was pushed into a wall or post", worstPen.toFixed(3));
  check(worstGrow === 0, "kinetic energy grew in a step", String(worstGrow));
  check(worstSpeed < PHYS.VMAX * 1.7, "a body went faster than a disc-on-ball strike allows", worstSpeed.toFixed(1));
  check(timeouts / n < 0.01, "too many flicks ran to the 9 s limit", `${timeouts}/${n}`);
  console.log(`  ${n} flicks: deepest wall overlap ${(-worstPen).toFixed(3)} u, top speed ${worstSpeed.toFixed(0)} u/s, ${timeouts} ran to 9 s`);
}

section("goal boxes: bodies driven hard into the net stay in the net");
{
  const r = rng(77);
  let n = 0, worst = 0, wrong = 0, goals = 0;
  for (let k = 0; k < 200; k++) {
    const end = k % 2;                                     // 0: toward y=100, 1: toward y=0
    const x = GX0 + 4 + r() * (GX1 - GX0 - 8), by = end === 0 ? 70 + r() * 20 : 30 - r() * 20;
    const b = empty([x, by]);
    const dy = end === 0 ? -9 : 9;
    b[end === 0 ? 3 : 8] = [x + (r() - 0.5) * 3, by + dy];
    const aim = (end === 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 0.4;
    const w = watch(b, end === 0 ? 3 : 8, aim, 0.7 + r() * 0.3);
    n++;
    worst = Math.min(worst, w.worstPen);
    if (w.outside) wrong++;
    if (w.out.result === "goal") goals++;
  }
  check(wrong === 0, "a body got out of a goal box through its walls", String(wrong));
  check(worst > -0.8, "a body sank into the back or side of a goal box", worst.toFixed(3));
  check(goals > 100, "driving the ball at the open goal should score most times", `${goals}/${n}`);
  console.log(`  ${n} hard drives into the goals: ${goals} goals, none escaped the net`);
}

section("the ball struck at full power into corners and end walls does not tunnel (smallest body, highest speed)");
{
  let n = 0, bad = 0;
  for (let ang = 0; ang < 360; ang += 3) {
    // the ball in a corner, the disc beside it, hit toward the corner at full power, from every direction
    for (const c of [[3, 3], [57, 3], [3, 97], [57, 97], [30, 2.3], [30, 97.7]]) {
      const b = empty(c);
      for (let i = 1; i < 10; i++) b[i] = [12 + ((i - 1) % 3) * 18, 38 + Math.floor((i - 1) / 3) * 12];   // the rest in the middle band, away from the corners
      const a = ang * Math.PI / 180;
      b[0] = [Math.min(W - 4.1, Math.max(4.1, c[0] + Math.cos(a) * 7)), Math.min(L - 4.1, Math.max(4.1, c[1] + Math.sin(a) * 7))];
      const aim = Math.atan2(c[1] - b[0][1], c[0] - b[0][0]);
      const w = watch(b, 0, aim, 1);
      n++;
      if (w.outside || w.worstPen < -0.8) bad++;
    }
  }
  check(bad === 0, "the ball got through a wall or post", `${bad}/${n}`);
  console.log(`  ${n} corner and end-wall strikes at full power, none through`);
}

/* ------------------------------------------------------------------ goals */
section("goal detection");
{
  // seat 1's disc sends the ball down the middle toward y=0; sweep the power from a tap to a full flick
  let line = null, lastStop = null, firstGoal = null;
  for (let p = 5; p <= 100; p++) {
    const b = empty([30, 8]); b[8] = [30, 17];
    const o = simulate(b, 8, -Math.PI / 2, p / 100);
    const [bx, by] = o.end[10];
    if (o.result === "goal") { if (firstGoal == null) firstGoal = p; check(o.goalFor === 1, "a ball over the y=0 line is seat 1's goal", JSON.stringify([p, o.goalFor])); check(by < -R[10], "a goal needs the centre past the line by more than the radius", by.toFixed(2)); }
    else {
      check(o.goalFor === undefined, "goalFor on a flick with no goal");
      if (by < 0 && by > -R[10] && !line) line = { p, by, result: o.result };
      lastStop = { p, by };
    }
  }
  check(firstGoal != null, "no power from 5 to 100 % scored from 8 u out");
  console.log(`  from 8 u out: the first power that scores is ${firstGoal} %; the last that does not ends at y=${lastStop && lastStop.by.toFixed(2)}`);
  // Find a power whose ball comes to rest ON the line (centre over it, not fully): that is not a goal.
  // The sweep above has a 1 % step, so search finely around the threshold.
  let onLine = line;
  for (let q = 0; !onLine && q < 4000; q++) {
    const p = (firstGoal - 2 + q * 0.001) / 100, b = empty([30, 8]); b[8] = [30, 17];
    const o = simulate(b, 8, -Math.PI / 2, p);
    const by = o.end[10][1];
    if (o.result !== "goal" && by < 0 && by > -R[10]) onLine = { p, by, result: o.result };
  }
  check(!!onLine, "never found a ball resting on the line");
  if (onLine) console.log(`  a ball resting at y=${onLine.by.toFixed(2)} (over the line, not fully) is "${onLine.result}", not a goal`);
  if (onLine) check(onLine.result === "stop", "a ball on the line should simply stop", onLine.result);

  // the same at the other end, and straight through the mouth, mirrored
  const b = empty([30, 92]); b[3] = [30, 83];
  const o = simulate(b, 3, Math.PI / 2, 1);
  check(o.result === "goal" && o.goalFor === 0, "seat 0 scores at y=100", o.result + " " + o.goalFor);
  const ev = o.events.find((e) => e.k === "goal");
  check(ev && ev.a === 0, "a goal event names the scoring seat", JSON.stringify(ev));
  check(o.frames.length > 0 && o.frames.length < 120, "a goal ends the flick soon after (frames)", String(o.frames.length));
  const lastBall = o.frames[o.frames.length - 1];
  check(lastBall[1] > L + R[10], "the ball is in the net in the last frame", String(lastBall[1]));

  // outside the mouth: a ball at the wall beside the goal is just a bounce
  const c = empty([8, 92]); c[3] = [8, 82];
  const oc = simulate(c, 3, Math.PI / 2, 1);
  check(oc.result !== "goal", "a ball on the end wall outside the mouth scored", oc.result);

  // an own goal counts for the other side
  const d = empty([30, 90]); d[8] = [30, 99];                  // seat 1's disc pokes the ball... back toward seat 0's end? aim up the pitch
  const od = simulate(d, 8, -Math.PI / 2 + 0.0, 1);
  check(od.result === "goal" && od.goalFor === 1, "a flick that puts the ball in the y=0 net is seat 1's goal, whoever struck it", od.result + " " + od.goalFor);
}

section("posts");
{
  const names = ["(21,0)", "(39,0)", "(21,100)", "(39,100)"];
  for (let p = 0; p < 4; p++) {
    const px = POSTS[p][0], py = POSTS[p][1];
    const inward = py === 0 ? 1 : -1;                          // the way into the pitch from this post
    const b = empty([px, py + inward * 12]);
    const disc = py === 0 ? 8 : 3;                             // the defending side's far disc, as a striker would be
    b[disc] = [px, py + inward * 22];
    const o = simulate(b, disc, inward > 0 ? -Math.PI / 2 : Math.PI / 2, 0.8);
    const hit = o.events.find((e) => e.k === "post");
    check(!!hit, `post ${names[p]}: a ball driven at it should ring it`, JSON.stringify(o.events.map((e) => e.k)));
    if (hit) {
      check(hit.b === p, `post ${names[p]}: the event should carry the post index as b`, JSON.stringify(hit));
      check(hit.a === 10 && hit.s > 0 && hit.s <= 1, `post ${names[p]}: a is the ball, s is 0..1`, JSON.stringify(hit));
    }
    check(o.result !== "goal", `post ${names[p]}: the ball went through the post`, o.result);
    const [, by] = o.end[10];
    check(inward > 0 ? by > 0 : by < L, `post ${names[p]}: the ball stayed out of the goal`, by.toFixed(1));
  }
  // a shot just inside the post goes in; just outside does not
  for (const [x, wantGoal] of [[GX0 + 2.6, true], [GX0 - 1.5, false]]) {
    const b = empty([x, 20]); b[8] = [x, 29];
    const o = simulate(b, 8, -Math.PI / 2, 0.9);
    check((o.result === "goal") === wantGoal, `a ball driven down x=${x} ${wantGoal ? "scores" : "does not score"}`, o.result);
  }
  console.log("  all four posts ring, report their index, and are solid");
}

/* ------------------------------------------------------------------ stopping, shapes, feel */
section("every body stops; frames and events have PROTOCOL's shape");
{
  const r = rng(404);
  let n = 0, shapeBad = 0, stopBad = 0, endBad = 0;
  const kinds = new Set();
  const seconds = [], withBall = [];
  for (let k = 0; k < 300; k++) {
    const f = formation(k % 2);
    const disc = Math.floor(r() * 10), aim = r() * Math.PI * 2, power = 0.15 + r() * 0.85;
    let finalV = 0;
    const o = simulate(f, disc, aim, power, { onStep: (s) => { finalV = 0; for (let i = 0; i < 11; i++) finalV = Math.max(finalV, Math.hypot(s.vx[i], s.vy[i])); } });
    n++;
    const fr = o.frames;
    if (!(fr.length >= 2 && fr.every((q) => q.length === 22 && q.every((v) => Math.abs(Math.round(v * 100) / 100 - v) < 1e-9)))) shapeBad++;
    // the first frame is where everything rested: ball first, then discs
    const first = fr[0], rest = [f[10], ...f.slice(0, 10)].flat();
    if (JSON.stringify(first) !== JSON.stringify(rest)) shapeBad++;
    // the last frame is where everything ends (ball first)
    const lastF = fr[fr.length - 1], end = [o.end[10], ...o.end.slice(0, 10)].flat();
    if (JSON.stringify(lastF) !== JSON.stringify(end)) endBad++;
    if (o.result === "stop" && finalV !== 0) stopBad++;
    if (o.result === "stop" || o.result === "goal") { seconds.push(fr.length / 60); if (o.events.some((e) => e.k === "kick")) withBall.push(fr.length / 60); }
    for (const e of o.events) {
      kinds.add(e.k);
      if (!(Number.isInteger(e.f) && e.f >= 0 && e.f < fr.length) || !["hit", "kick", "wall", "post", "goal", "near", "save"].includes(e.k)) shapeBad++;
      if (e.s !== undefined && !(e.s >= 0 && e.s <= 1)) shapeBad++;
    }
    for (let i = 1; i < o.events.length; i++) if (o.events[i].f < o.events[i - 1].f) shapeBad++;
  }
  check(shapeBad === 0, "a frame or an event had the wrong shape", String(shapeBad));
  check(endBad === 0, "the last frame is not where the bodies end", String(endBad));
  check(stopBad === 0, "a flick reported \"stop\" with a body still moving", String(stopBad));
  for (const k of ["hit", "kick", "wall"]) check(kinds.has(k), `no "${k}" event in 300 flicks`);
  seconds.sort((a, b) => a - b);
  const med = seconds[Math.floor(seconds.length / 2)], p90 = seconds[Math.floor(seconds.length * 0.9)];
  withBall.sort((a, b) => a - b);
  const medB = withBall[Math.floor(withBall.length / 2)], p90B = withBall[Math.floor(withBall.length * 0.9)];
  check(med >= 1.5 && med <= 5 && p90 <= 6.5, "turns should settle in about 2-5 s", `median ${med.toFixed(2)} s, p90 ${p90.toFixed(2)} s`);
  check(medB >= 2 && medB <= 5 && p90B <= 6.5, "turns with the ball in them should settle in 2-5 s", `median ${medB.toFixed(2)} s, p90 ${p90B.toFixed(2)} s`);
  console.log(`  ${n} flicks: events seen ${Array.from(kinds).sort().join(", ")}; settle time median ${med.toFixed(2)} s, 90th percentile ${p90.toFixed(2)} s; ${withBall.length} touched the ball: median ${medB.toFixed(2)} s, 90th ${p90B.toFixed(2)} s`);
}

section("events: save, near");
{
  // a ball heading into the mouth meets the keeper-side disc inside 18 u of the line
  let saved = 0, near = 0;
  for (let k = 0; k < 40; k++) {
    const b = empty([30, 40 - k * 0.1]); b[8] = [30, 49]; b[2] = [30 + (k % 5 - 2), 17];     // seat 0 disc 2 stands in front of its own goal
    const o = simulate(b, 8, -Math.PI / 2, 0.95);
    if (o.events.some((e) => e.k === "save" && e.a === 2)) saved++;
  }
  check(saved > 0, "a disc stopping a ball heading into the mouth should be a save", `${saved}/40`);
  // near: the ball grazing a post, or crossing the line and coming back
  for (let k = 0; k < 40; k++) {
    const b = empty([GX0 + 0.5 + k * 0.05, 20]); b[8] = [GX0 + 0.5 + k * 0.05, 29];
    const o = simulate(b, 8, -Math.PI / 2, 0.8);
    const e = o.events.find((q) => q.k === "near");
    if (e) { near++; check(e.a === 1, "near carries the attacking seat as a (seat 1 attacks y=0)", JSON.stringify(e)); }
  }
  check(near > 0, "a ball skimming a post should be a near miss", `${near}/40`);
  console.log(`  ${saved}/40 saves, ${near}/40 near misses`);
}

section("the numbers play well");
{
  // a lone disc, full power, open floor
  const b = empty([57, 5]);
  b[0] = [30, 12];
  const o = simulate(b, 0, Math.PI / 2, 1);
  const lone = o.end[0][1] - 12;
  const calc = freeTravel(flickSpeed(1), false);
  check(Math.abs(calc.dist - 110) < 8, "freeTravel(full flick) should be ~110 u", calc.dist.toFixed(1));
  // on the real table the disc meets the far goal's back wall (110 u from y=12 is past the line); measure sideways instead
  const side = empty([57, 5]); side[0] = [2, 60]; side[4] = [2, 50]; side[5] = [58, 20];
  const so = simulate(side, 0, 0, 1);
  const cross = so.frames.map((q) => q[2]);           // disc 0's x over time
  const peak = Math.max(...cross);
  check(peak > 50, "a full flick should carry a disc right across the table", peak.toFixed(1));
  console.log(`  a lone disc at full power rolls ${calc.dist.toFixed(1)} u on an open floor in ${calc.seconds.toFixed(2)} s (the table is 60 x 100); half power ${freeTravel(flickSpeed(0.5), false).dist.toFixed(1)} u`);
  void lone;

  // a ball struck from midfield reaches the far goal
  let reach = 0, tried = 0;
  for (const p of [0.45, 0.6, 0.8, 1]) for (const dx of [-1.5, 0, 1.5]) {
    const g = empty([30 + dx, 50]); g[0] = [30 + dx, 38];
    const o = simulate(g, 0, Math.PI / 2, p);
    tried++; if (o.result === "goal" && o.goalFor === 0) reach++;
  }
  check(reach >= 8, "a ball struck from midfield should reach the far goal", `${reach}/${tried}`);
  console.log(`  struck from midfield, straight: ${reach}/${tried} reach the far goal`);
  // and the weakest tap that still scores from there
  let min = null;
  for (let p = 5; p <= 100 && min == null; p++) { const g = empty([30, 50]); g[0] = [30, 38]; if (simulate(g, 0, Math.PI / 2, p / 100).result === "goal") min = p; }
  console.log(`  the weakest tap that scores from the centre spot is ${min} % power`);
}

console.log(failures === 0 ? `\nphysics: all good (${checks} checks)\n` : `\nphysics: ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
