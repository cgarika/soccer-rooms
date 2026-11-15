/* Table Soccer — one bot-thinking worker (see bots.js). It answers "which flick would a bot play from here?" and nothing
   else: it holds no rooms and decides no results. */

"use strict";
const { parentPort } = require("worker_threads");
const { botFlick, seeded } = require("./bots");

// test hook: a worker that never answers, so the pool's late-answer path can be proved
const HANG = process.env.BOT_WORKER_TEST_HANG === "1";

parentPort.on("message", (m) => {
  if (HANG) return;
  let out = null;
  try { out = botFlick(m.bodies, m.seat, m.level, m.seed != null ? seeded(m.seed) : Math.random); }
  catch (e) { out = null; }
  parentPort.postMessage(out ? { id: m.id, disc: out.disc, aim: out.aim, power: out.power } : { id: m.id, error: true });
});
