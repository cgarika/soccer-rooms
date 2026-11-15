/* Gear (2026-11-08, Carrom and Table Soccer 2026-11-09): the one gear table (gear.json, the same file in the app, the room servers and the wallet) and what a server does with it.
   The same file in pool-rooms, brawl-rooms, carrom-rooms and soccer-rooms. Pure: no I/O after load.

   A player's gear is one item per slot and a level for each (Pool: cue, chalk, glove; Bumper Bash: body, engine, bumper; Carrom: striker, powder, cglove; Table Soccer: discs,
   keeper, boots). The app sends it when it joins: { cue: { item: "cue:sapphire", level: 5 }, chalk: {...}, glove: {...} }. clean() clamps every level to its item's rarity range (COMMON 1-6,
   RARE 2-8, EPIC 3-10, LEGENDARY 5-12; PLUS counts as EPIC) and throws away an item the table does not know (that slot plays as the starter item).
   A stat is the sum of what the equipped pieces give at their levels, never over 10. A player who sent no gear at all gets null: base values. */
"use strict";

const fs = require("fs");
const path = require("path");
const T = JSON.parse(fs.readFileSync(path.join(__dirname, "gear.json"), "utf8"));

const CAP = T.statCap;
const RULES = { lm1: (L) => L - 1, half: (L) => Math.floor(L / 2) };
const clampStat = (v) => Math.max(0, Math.min(CAP, v));
const rarityOf = (item) => { const i = T.items[item]; return i ? i.rarity : null; };
const range = (rarity) => T.rarity[rarity];
const slotsOf = (game) => (T.games[game] ? T.games[game].slots : []);
const starterOf = (slot) => T.starter[slot];

function clampLevel(item, level) {
  const r = range(rarityOf(item));
  const L = Number.isFinite(level) ? Math.trunc(level) : r.min;
  return Math.max(r.min, Math.min(r.max, L));
}

/** What one piece gives at a level: { statId: points } (before the 10 cap across pieces). */
function pieceStats(slot, level) {
  const out = {};
  for (const s of T.slots[slot].stats) out[s.id] = clampStat(RULES[s.rule](level));
  return out;
}

/** The sum of the equipped pieces' stats, each stat at most 10. */
function statsOf(game, slotsEq) {
  const out = {};
  for (const id of T.games[game].stats) out[id] = 0;
  for (const slot of slotsOf(game)) {
    const e = slotsEq[slot];
    const p = pieceStats(slot, e.level);
    for (const id of Object.keys(p)) out[id] = clampStat(out[id] + p[id]);
  }
  return out;
}

const scoreOf = (game, slotsEq) => slotsOf(game).reduce((n, s) => n + slotsEq[s].level, 0);

/** A player's gear from what the app sent (or null for none: base values). Always returns every slot, clamped. */
function clean(game, raw) {
  if (!T.games[game] || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const eq = {};
  for (const slot of slotsOf(game)) {
    const r = raw[slot] && typeof raw[slot] === "object" ? raw[slot] : {};
    const item = typeof r.item === "string" && T.items[r.item] && T.items[r.item].slot === slot ? r.item : starterOf(slot);
    eq[slot] = { item, level: clampLevel(item, typeof r.level === "number" ? r.level : NaN) };
  }
  return { slots: eq, stats: statsOf(game, eq), score: scoreOf(game, eq) };
}

/** A bot's gear for a gear score (3 to 36): the levels split as evenly as the rarities allow, each in the lowest-rarity item whose range holds it. */
function botGear(game, score) {
  const slots = slotsOf(game);
  let left = Math.max(slots.length, Math.min(slots.length * 12, Math.round(score)));
  const lv = slots.map(() => 1); left -= slots.length;
  for (let i = 0; left > 0 && i < 1000; i++) { const k = i % slots.length; if (lv[k] < 12) { lv[k]++; left--; } }
  const raw = {};
  slots.forEach((slot, k) => {
    const L = lv[k];
    const order = ["common", "rare", "epic", "legendary"];
    const have = (x) => Object.keys(T.items).find((i) => T.items[i].slot === slot && T.items[i].rarity === x && !T.items[i].plus);
    const r = order.find((x) => L >= range(x).min && L <= range(x).max && have(x)) || order.filter(have).pop();   // a slot with no LEGENDARY item tops out at its best
    const key = have(r);
    raw[slot] = { item: key, level: L };
  });
  return clean(game, raw);
}

/** Two players' scores are in one band when they are within BAND points of each other (quick and ranked play match within it). */
const BAND = 6;
const bandOk = (a, b) => Math.abs((a || 0) - (b || 0)) <= BAND;
/** No gear counts as the starter set (3). */
const scoreFor = (g, game) => (g ? g.score : slotsOf(game || "pool").length);

/* ---------- what the server does with the stats ---------- */

/** Pool: power +3% top speed a point, spin +6% a point, shot time +1 s a point. The aim line (+8% a point) is the app's. */
function poolEffects(stats) {
  const s = stats || {};
  return { speed: 1 + 0.03 * (s.power || 0), spin: 1 + 0.06 * (s.spin || 0), shotMs: 1000 * (s.shot || 0), aim: 1 + 0.08 * (s.aim || 0) };
}

/** Bumper Bash: weight +5% mass a point; bump power +4% of an impact's push a point; speed +3% acceleration and +2% top speed a point;
    boost cooldown -4% a point (120 ticks down to 72 at 10). Integers, so the phone's port is exact. */
const BOOST_CD_BY = [120, 115, 110, 106, 101, 96, 91, 86, 82, 77, 72];
function brawlEffects(stats) {
  const s = stats || {};
  const i = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(CAP, Math.trunc(v))) : 0);
  return { gw: i(s.weight), gp: i(s.bump), gs: i(s.speed), gc: i(s.boost) };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Carrom: power +3% striker top speed a point; glide -3% board friction a point (the slide's deceleration, for that player's shots); shot time +1 s a point; aim line +8% a point (the app's). */
function carromEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  return { speed: r4(1 + 0.03 * p("power")), glide: r4(1 - 0.03 * p("glide")), shotMs: 1000 * p("shot"), aim: r4(1 + 0.08 * p("aim")) };
}

/** Table Soccer: power +3% flick top speed a point; reach +4% keeper block radius a point; shot time +1 s a point; aim line +8% a point (the app's). */
function soccerEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  return { speed: r4(1 + 0.03 * p("power")), reach: r4(1 + 0.04 * p("reach")), shotMs: 1000 * p("shot"), aim: r4(1 + 0.08 * p("aim")) };
}

module.exports = { T, CAP, BAND, BOOST_CD_BY, rarityOf, range, slotsOf, starterOf, clampLevel, pieceStats, statsOf, scoreOf, clean, botGear, bandOk, scoreFor, poolEffects, brawlEffects, carromEffects, soccerEffects };
