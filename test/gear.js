/* Gear (2026-11-09, step 3): the table's Table Soccer slots, the clamps, the physics (the discs' power, the keeper's reach), the flick clock (boots), the host's gear switch, the bands quick play
   matches within, the bots' gear, and that no gear is exactly the base values.
   Run: node test/gear.js   (its own server on TEST_PORT_GEAR, default 5636; never 3111-3126) */
"use strict";
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const { io } = require("socket.io-client");
const G = require("../gear");
const { PHYS, simulate, formation, flickSpeed } = require("../physics");

const PORT = Number(process.env.TEST_PORT_GEAR || 5636);
if (PORT >= 3111 && PORT <= 3126) { console.error("refusing " + PORT + ": the live servers"); process.exit(2); }
let passes = 0, failures = 0;
const check = (ok, what, extra) => { if (ok) passes++; else { failures++; console.log("  FAIL: " + what + (extra !== undefined ? "  " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } return !!ok; };
const section = (n) => console.log("\n" + n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = (port) => new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port); });   // no host: any listener on the port, IPv4 or IPv6, makes it busy

const COST = { 2: 300, 3: 600, 4: 1000, 5: 1500, 6: 2500, 7: 4000, 8: 6000, 9: 9000, 10: 13000, 11: 18000, 12: 24000 };
const OPAL = { discs: { item: "discs:opal", level: 10 }, keeper: { item: "keeper:opal", level: 6 }, boots: { item: "boots:opal", level: 8 } };

async function startServer(env) {
  if (!(await freePort(PORT))) throw new Error(`port ${PORT} is busy; set TEST_PORT_GEAR to a free one`);
  const child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), BOT_MS: "5", TURN_MS: "15000", PLAYBACK_SCALE: "20", GOAL_PAUSE_MS: "100", BOT_WORKERS: "1", TEST_HOOKS: "1", ...env } });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error("server exited:\n" + log);
    if (/running on port/.test(log)) break;      // this copy's own word that it listens (never another server's answer on the port)
    if (Date.now() - t0 > 20000) { child.kill(); throw new Error("server did not start:\n" + log); }
    await sleep(100);
  }
  return { child, stop: () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill("SIGTERM"); }) };
}
function client(name) {
  const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.nm = name; s.st = null; s.seat = -1; s.errors = [];
  s.playerId = "p" + Math.random().toString(16).slice(2, 14);
  s.on("state", ({ room, mySeat }) => { s.st = room; s.seat = mySeat; });
  s.on("err", (m, e) => s.errors.push([m, e]));
  return s;
}
const connected = (s) => new Promise((res) => (s.connected ? res() : s.once("connect", res)));
async function waitFor(s, pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred(s)) return true; } catch (_) {} await sleep(10); } return false; }
/* A room with the host and `humans - 1` more humans and `bots` bots, not yet started. */
async function lobby(humans, bots, hostExtra = {}) {
  const host = client("host"); await connected(host);
  host.emit("create", { name: "Host", playerId: host.playerId, ...hostExtra });
  await waitFor(host, (s) => s.st);
  const others = [];
  for (let i = 1; i < humans; i++) {
    const c = client("g" + i); await connected(c);
    c.emit("join", { code: host.st.code, name: "Guest" + i, playerId: c.playerId });
    await waitFor(c, (s) => s.st && s.seat >= 0);
    others.push(c);
  }
  for (let i = 0; i < bots; i++) { const n = host.st.players.length; host.emit("addBot", { level: "normal" }); await waitFor(host, (s) => s.st.players.length > n); }
  return { host, others, all: [host, ...others] };
}

(async () => {
  section("the table: Table Soccer's slots, items, rarities, costs and caps");
  {
    for (const [L, c] of Object.entries(COST)) check(G.T.levelCost[L] === c, `level ${L} costs ${c}`, G.T.levelCost[L]);
    const r = G.T.rarity;
    check(r.common.min === 1 && r.common.max === 6 && r.rare.min === 2 && r.rare.max === 8 && r.epic.min === 3 && r.epic.max === 10 && r.legendary.min === 5 && r.legendary.max === 12, "COMMON 1-6, RARE 2-8, EPIC 3-10, LEGENDARY 5-12");
    check(JSON.stringify(G.slotsOf("soccer")) === '["discs","keeper","boots"]' && JSON.stringify(G.T.games.soccer.stats) === '["power","aim","reach","shot"]', "Table Soccer: discs, keeper, boots; power, aim, reach, shot");
    for (const slot of G.slotsOf("soccer")) {
      const items = Object.keys(G.T.items).filter((k) => G.T.items[k].slot === slot);
      check(items.length === 4, `${slot}: four items`, items);
      check(["common", "rare", "epic", "legendary"].every((x, i) => G.rarityOf(items[i]) === x), `${slot}: one COMMON, RARE, EPIC and LEGENDARY, in that order`, items.map(G.rarityOf));
      check(G.rarityOf(G.starterOf(slot)) === "common" && items[0] === G.starterOf(slot), `${slot}: everyone starts with the COMMON one (${G.starterOf(slot)})`);
      check(items.every((k) => !G.T.items[k].plus && !G.T.items[k].pass), `${slot}: no Plus or pass items`);
    }
    check(G.rarityOf("discs:chrome") === "rare" && G.rarityOf("discs:opal") === "epic" && G.rarityOf("discs:dragon") === "legendary", "the Chrome, Opal and Dragon discs are RARE, EPIC and LEGENDARY");
    check(G.pieceStats("discs", 6).power === 5 && G.pieceStats("discs", 6).aim === 5, "the discs give power and aim, level 1 is the base");
    check(G.pieceStats("keeper", 11).reach === 10 && G.pieceStats("keeper", 12).reach === 10 && Object.keys(G.pieceStats("keeper", 5)).join() === "reach", "keeper: reach only, never over 10");
    check(G.pieceStats("boots", 8).shot === 7, "boots: shot time");
    for (const slot of G.slotsOf("soccer")) {
      let prev = null;
      for (let L = 1; L <= 12; L++) {
        const p = G.pieceStats(slot, L);
        check(Object.values(p).every((v) => v >= 0 && v <= G.CAP), `${slot} L${L}: no stat over ${G.CAP}`, p);
        if (prev && L <= 11) check(Object.keys(p).every((k) => p[k] - prev[k] === 0 || p[k] - prev[k] === 1) && Object.keys(p).some((k) => p[k] === prev[k] + 1), `${slot} L${L}: +1 to one or two stats`, { prev, p });
        prev = p;
      }
    }
  }

  section("clean(): clamps and fallbacks");
  {
    const g = G.clean("soccer", { discs: { item: "discs:opal", level: 99 }, keeper: { item: "nope", level: 7 }, boots: { item: "discs:chrome", level: 5 } });
    check(g.slots.discs.level === 10, "opal (EPIC) at 99 is 10", g.slots.discs);
    check(g.slots.keeper.item === "keeper:classic" && g.slots.keeper.level === 6, "an unknown item is the starter, and its level is clamped to COMMON's 6", g.slots.keeper);
    check(g.slots.boots.item === "boots:classic", "an item from another slot is the starter", g.slots.boots);
    check(G.clean("soccer", { discs: { item: "discs:classic", level: 0 } }).slots.discs.level === 1, "a COMMON below its floor is 1");
    check(G.clean("soccer", { discs: { item: "discs:chrome", level: 1 } }).slots.discs.level === 2, "a RARE below its floor is 2");
    check(G.clean("soccer", { discs: { item: "discs:dragon", level: 1 } }).slots.discs.level === 5, "a LEGENDARY below its floor is 5");
    check(G.clean("soccer", { discs: { item: "discs:opal", level: "7" } }).slots.discs.level === 3, "a level that is not a number is the item's floor");
    check(G.clean("soccer", null) === null && G.clean("soccer", []) === null && G.clean("soccer", "x") === null, "no gear is null");
    check(G.clean("soccer", {}).score === 3, "an empty object is the starter set, score 3");
    check(G.clean("soccer", { striker: { item: "striker:dragon", level: 9 } }).score === 3, "Carrom's slots mean nothing to Table Soccer");
    check(G.clean("carrom", OPAL).slots.striker.item === "striker:classic", "and Table Soccer's mean nothing to Carrom");
    const full = G.clean("soccer", OPAL);
    check(full.score === 24 && full.stats.power === 9 && full.stats.aim === 9 && full.stats.reach === 5 && full.stats.shot === 7, "gear score is the sum of the levels; stats from the pieces", full);
    const max = G.clean("soccer", { discs: { item: "discs:dragon", level: 12 }, keeper: { item: "keeper:dragon", level: 12 }, boots: { item: "boots:dragon", level: 12 } });
    check(max.score === 36 && max.stats.power === 10 && max.stats.aim === 10 && max.stats.reach === 10 && max.stats.shot === 10, "everything at the top: 36 and 10s", max);
  }

  section("the effects: +3% speed, +4% keeper radius, +1 s, +8% aim a point");
  {
    const fx10 = G.soccerEffects({ power: 10, aim: 10, reach: 10, shot: 10 });
    check(Math.abs(fx10.speed - 1.3) < 1e-9 && Math.abs(fx10.reach - 1.4) < 1e-9 && fx10.shotMs === 10000 && Math.abs(fx10.aim - 1.8) < 1e-9, "at 10 points: 1.3x speed, 1.4x keeper radius, +10 s, 1.8x aim", fx10);
    const none = G.soccerEffects(null);
    check(none.speed === 1 && none.reach === 1 && none.shotMs === 0 && none.aim === 1, "no stats are the base", none);
    const bad = G.soccerEffects({ power: "x", reach: -3, shot: 99 });
    check(bad.speed === 1 && bad.reach === 1 && bad.shotMs === 10000, "nonsense is nothing, and a stat is held to 0..10", bad);
  }

  section("the bots' gear fits the band");
  {
    for (const score of [3, 7, 12, 20, 29, 36]) { const b = G.botGear("soccer", score); check(b.score === score, `a bot at score ${score}`, b.score); }
    check(G.botGear("soccer", 100).score === 36 && G.botGear("soccer", 0).score === 3, "clamped to 3..36");
    check(G.bandOk(10, 16) && !G.bandOk(10, 17) && G.bandOk(3, G.scoreFor(null, "soccer")), "a band is 6 points; no gear counts as 3");
  }

  section("the physics: power and the keeper's reach, and no gear is the base");
  {
    const bodies = formation(0);
    const base = simulate(bodies, 3, 1.1, 0.8);
    check(JSON.stringify(base) === JSON.stringify(simulate(bodies, 3, 1.1, 0.8, undefined)) && JSON.stringify(base) === JSON.stringify(simulate(bodies, 3, 1.1, 0.8, {})) &&
      JSON.stringify(base) === JSON.stringify(simulate(bodies, 3, 1.1, 0.8, { speed: 1, keepers: [1, 1] })) && JSON.stringify(base) === JSON.stringify(simulate(bodies, 3, 1.1, 0.8, { keepers: null })), "no gear (nothing, {}, 1 and 1, no keepers) is byte-for-byte the base");
    // the flick's top speed: the flicked disc's first frames
    const at = (sh, d, k) => [sh.frames[k][2 + 2 * d], sh.frames[k][3 + 2 * d]];
    const step = (sh, d) => { const a = at(sh, d, 0), b = at(sh, d, 1); return Math.hypot(b[0] - a[0], b[1] - a[1]); };
    const lone = formation(null); lone[3] = [10, 60];
    const s1 = simulate(lone, 3, 0, 1), s2 = simulate(lone, 3, 0, 1, { speed: 1.3 });
    check(Math.abs(step(s2, 3) / step(s1, 3) - 1.3) < 0.02, `power 10 is 30% more top speed (${step(s1, 3).toFixed(3)} -> ${step(s2, 3).toFixed(3)} a frame)`, [step(s1, 3), step(s2, 3)]);
    check(Math.abs(flickSpeed(1) - PHYS.VMAX) < 1e-9, "the base flick is VMAX");
    // the keeper: a disc driven down a lane 8.8 from the keeper's middle (disc 4 + keeper 4 = 8 apart to touch: it slips by; with reach 10 the keeper is 5.6 and 9.6 is the touch)
    const park = formation(null);
    park[1] = [6, 62]; park[2] = [54, 62]; park[3] = [30, 72]; park[4] = [38.8, 45];
    park[10] = [20, 55];
    const miss = simulate(park, 4, -Math.PI / 2, 0.6);
    const hits = (sh, a, b) => sh.events.filter((e) => e.k === "hit" && ((e.a === a && e.b === b) || (e.a === b && e.b === a))).length;
    check(hits(miss, 4, 0) === 0, "the base keeper is slipped by at 8.8", miss.events);
    const blocked = simulate(park, 4, -Math.PI / 2, 0.6, { keepers: [1.4, 1] });
    check(hits(blocked, 4, 0) >= 1, "a keeper with reach 10 (radius 5.6) blocks the same flick", blocked.events);
    const other = simulate(park, 4, -Math.PI / 2, 0.6, { keepers: [1, 1.4] });
    check(hits(other, 4, 0) === 0, "and seat 1's reach does not grow seat 0's keeper", other.events);
    // seat 1's keeper is disc 5
    const park2 = formation(null);
    park2[6] = [54, 40]; park2[7] = [6, 40]; park2[8] = [30, 30]; park2[9] = [20, 25]; park2[10] = [40, 45];
    park2[0] = [30, 9]; park2[1] = [6, 20]; park2[2] = [54, 20]; park2[3] = [10, 30]; park2[4] = [21.2, 55];
    const miss5 = simulate(park2, 4, Math.PI / 2, 0.6);
    const hit5 = simulate(park2, 4, Math.PI / 2, 0.6, { keepers: [1, 1.4] });
    check(hits(miss5, 4, 5) === 0 && hits(hit5, 4, 5) >= 1, "seat 1's keeper (disc 5) takes its own reach");
  }

  section("parity: 400 random flicks with random gear are deterministic, finish and stay on the table");
  {
    let seed = 20261109;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let bad = 0, lightBad = 0;
    for (let i = 0; i < 400; i++) {
      let bodies = formation(i % 3 === 0 ? null : i % 2);
      bodies = bodies.map(([x, y], k) => (k === 10 || rnd() < 0.5 ? [x, y] : [Math.min(56, Math.max(4, x + (rnd() - 0.5) * 8)), Math.min(96, Math.max(4, y + (rnd() - 0.5) * 8))]));
      const fx = G.soccerEffects({ power: Math.floor(rnd() * 11), reach: Math.floor(rnd() * 11) }), fy = G.soccerEffects({ reach: Math.floor(rnd() * 11) });
      const opts = { speed: fx.speed, keepers: [fx.reach, fy.reach] };
      const disc = Math.floor(rnd() * 10), aim = rnd() * Math.PI * 2, power = 0.05 + rnd() * 0.95;
      const x = simulate(bodies, disc, aim, power, opts), y = simulate(bodies, disc, aim, power, opts);
      if (JSON.stringify(x) !== JSON.stringify(y) || !(x.steps > 0) || x.steps > PHYS.MAX_S * PHYS.STEP_HZ) bad++;
      for (const [px, py] of x.end) if (!Number.isFinite(px) || !Number.isFinite(py) || px < -0.01 || px > PHYS.W + 0.01 || py < -PHYS.GOAL_DEPTH - 0.01 || py > PHYS.L + PHYS.GOAL_DEPTH + 0.01) bad++;
      // a bot's practice swing (light) reaches the same end as the real one
      const l = simulate(bodies, disc, aim, power, Object.assign({ light: true }, opts));
      if (JSON.stringify(l.end) !== JSON.stringify(x.end) || l.result !== x.result) lightBad++;
    }
    check(bad === 0, "every geared flick is deterministic, ends within 9 s and leaves every body inside the pitch", bad);
    check(lightBad === 0, "a practice swing (light) ends where the real flick does", lightBad);
  }

  const S = await startServer({});
  try {
    section("gear is accepted on create and join, clamped, and shown to the table");
    {
      const a = client("a"); await connected(a);
      a.emit("create", { name: "Ava", playerId: a.playerId, gear: { ...OPAL, discs: { item: "discs:opal", level: 500 } } });
      await waitFor(a, (s) => s.st);
      const me = a.st.players[0];
      check(me.gear && me.gear.score === 24 && me.gear.levels.discs === 10 && me.gear.items.discs === "discs:opal", "Ava's gear is on her seat, clamped", me.gear);
      check(me.gear.stats.power === 9 && me.gear.stats.reach === 5 && me.gear.fx.reach === 1.2 && a.st.gearOn === true, "stats are in force (keeper radius x1.2), the gear switch is on", me.gear);
      const old = client("old"); await connected(old);
      old.emit("join", { code: a.st.code, name: "Old", playerId: old.playerId });
      await waitFor(old, (s) => s.st && s.seat >= 0);
      await waitFor(a, (s) => s.st.players.length === 2);
      check(a.st.players[1].gear === null, "an old app that sends no gear has none", a.st.players[1].gear);
      for (const s of [a, old]) s.close();
      const b = client("b"); await connected(b);
      b.emit("create", { name: "Bo", playerId: b.playerId });
      await waitFor(b, (s) => s.st);
      const j = client("j"); await connected(j);
      j.emit("join", { code: b.st.code, name: "Jo", playerId: j.playerId, gear: { discs: { item: "discs:classic", level: 9 }, keeper: "x", boots: null } });
      await waitFor(b, (s) => s.st.players.length === 2);
      const jo = b.st.players[1].gear;
      check(jo && jo.levels.discs === 6 && jo.levels.keeper === 1 && jo.score === 8, "Jo's classic discs (COMMON) are held at 6, the rest are the starters", jo);
      for (const s of [b, j]) s.close();
    }

    section("a gear change in the lobby (the gear page's upgrade) reaches the table, clamped");
    {
      const a = client("gl"); await connected(a);
      a.emit("create", { name: "Gl", playerId: a.playerId });
      await waitFor(a, (s) => s.st);
      check(a.st.players[0].gear === null, "no gear at first");
      a.emit("gear", { discs: { item: "discs:opal", level: 99 }, keeper: { item: "keeper:opal", level: 4 } });
      check(await waitFor(a, (s) => s.st.players[0].gear && s.st.players[0].gear.levels.discs === 10), "the discs are held at the EPIC top");
      check(a.st.players[0].gear.levels.keeper === 4 && a.st.players[0].gear.levels.boots === 1, "the keeper as sent, the boots the starter", a.st.players[0].gear.levels);
      a.emit("addBot", { level: "normal" }); await waitFor(a, (s) => s.st.players.length === 2); a.emit("start"); await waitFor(a, (s) => s.st.status === "playing");
      a.emit("gear", { discs: { item: "discs:opal", level: 3 } }); await sleep(150);
      check(a.st.players[0].gear.levels.discs === 10, "in a match it is refused");
      a.close();
    }

    section("the host's gear switch");
    {
      const r = await lobby(2, 0, { gear: OPAL });
      const [h, g] = r.all;
      g.emit("settings", { gear: false });
      await sleep(150);
      check(h.st.gearOn === true, "a guest cannot switch gear off");
      h.emit("settings", { gear: false });
      check(await waitFor(h, (s) => s.st.gearOn === false), "the host can");
      check(h.st.players[0].gear.stats.power === 0 && h.st.players[0].gear.score === 24 && h.st.players[0].gear.fx.reach === 1, "off: the stats and the reach are nothing, the score is still shown", h.st.players[0].gear);
      h.emit("start");
      await waitFor(h, (s) => s.st.status === "playing");
      const clock = h.st.turnEndsAt - h.st.serverNow;
      check(clock > 13500 && clock < 15500, `gear off: the flick clock is the base 15 s (${clock} ms)`, clock);
      for (const s of r.all) s.close();
    }

    section("the boots add seconds to the flick clock");
    {
      const r = await lobby(1, 1, { gear: { boots: { item: "boots:opal", level: 8 } } });
      const h = r.host;
      h.emit("start");
      await waitFor(h, (s) => s.st.status === "playing");
      const clock = h.st.turnEndsAt - h.st.serverNow;
      check(clock > 21000 && clock < 23000, `boots level 8 (+7 s): 22 s (${clock} ms)`, clock);
      for (const s of r.all) s.close();
    }
    section("a player with no gear plays at the base clock, and the bot has none");
    {
      const r = await lobby(1, 1);
      r.host.emit("start");
      await waitFor(r.host, (s) => s.st.status === "playing");
      const clock = r.host.st.turnEndsAt - r.host.st.serverNow;
      check(clock > 13500 && clock < 15500, `15 s (${clock} ms)`, clock);
      check(r.host.st.players[1].gear === null, "nobody sent gear, so the bot has none");
      for (const s of r.all) s.close();
    }

    section("the bot's gear fits the human's band, and the bot's keeper stays at the base");
    {
      const r = await lobby(1, 1, { gear: OPAL });
      r.host.emit("start");
      await waitFor(r.host, (s) => s.st.status === "playing");
      const bot = r.host.st.players[1], me = r.host.st.players[0];
      check(bot.gear && bot.gear.score === 24 && bot.gear.items.discs, "the bot's score is the human's (24) and it wears discs", bot.gear);
      check(bot.gear.fx.reach === 1 && me.gear.fx.reach === 1.2, "the bot's keeper is the base size, the human's has reach 5", [bot.gear.fx, me.gear.fx]);
      for (const s of r.all) s.close();
    }

    section("a flick with gear is harder: over a socket");
    {
      const run = async (gear) => {
        const r = await lobby(1, 1, gear ? { gear } : {});
        r.host.emit("start");
        await waitFor(r.host, (s) => s.st.status === "playing" && s.st.turn === 0);
        r.host.emit("testSet", { bodies: [[30, 9], [14, 26], [46, 26], [10, 60], [39, 41], [30, 91], [14, 74], [46, 74], [21, 59], [39, 59], [30, 50]], kickoff: false });
        await sleep(100);
        r.host.emit("flick", { disc: 3, aim: 0, power: 1 });
        await waitFor(r.host, (s) => s.st.lastShot && s.st.lastShot.seat === 0);
        const f = r.host.st.lastShot.frames;
        const d = Math.hypot(f[1][2 + 6] - f[0][2 + 6], f[1][3 + 6] - f[0][3 + 6]);
        for (const s of r.all) s.close();
        return d;
      };
      const base = await run(null);
      const gear = await run({ discs: { item: "discs:opal", level: 10 } });
      check(Math.abs(gear / base - 1.27) < 0.02, `level 10 discs: power 9 = +27% (${base.toFixed(3)} -> ${gear.toFixed(3)} a frame)`, [base, gear]);
    }

    section("quick play matches within a gear-score band");
    {
      const lo = client("lo"), hi = client("hi"), mid = client("mid");
      for (const c of [lo, hi, mid]) await connected(c);
      lo.emit("quick", { name: "Lo", playerId: lo.playerId });                                   // score 3
      await waitFor(lo, (s) => s.st && s.st.quick);
      hi.emit("quick", { name: "Hi", playerId: hi.playerId, gear: OPAL });                        // 24: outside the band of 3
      await waitFor(hi, (s) => s.st && s.st.quick);
      check(hi.st.code !== lo.st.code, "a score of 24 does not join a score of 3", [hi.st.code, lo.st.code]);
      mid.emit("quick", { name: "Mid", playerId: mid.playerId, gear: { discs: { item: "discs:chrome", level: 4 }, keeper: { item: "keeper:classic", level: 3 } } });   // 4 + 3 + 1 = 8: 5 from 3
      await waitFor(mid, (s) => s.st && s.st.quick);
      check(mid.st.code === lo.st.code, "a score of 8 does join a score of 3", [mid.st.code, lo.st.code]);
      const ng = client("ng"); await connected(ng);
      ng.emit("quick", { name: "Ng", playerId: ng.playerId, gear: OPAL });
      await waitFor(ng, (s) => s.st && s.st.quick);
      check(ng.st.code === hi.st.code, "the same band meets", [ng.st.code, hi.st.code]);
      for (const s of [lo, hi, mid, ng]) s.close();
    }
  } finally { await S.stop(); }
  console.log(`\ngear: ${passes} checks passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
