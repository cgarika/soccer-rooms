/* Runs every suite: the physics, the bots and the shared modules in process, and the socket suites against server
   copies this script starts and stops itself.

     node test/run.js                     ports 3641-3644
     TEST_PORTS=3652,3653,3654,3655 node test/run.js

   Ports: [0] the "fast" server (a goal pause long enough to see, playback sped up), [1] the "turn" server (short turn
   and AFK clocks), [2] reactions.js's own server (TEST_PORT3), [3] waiting.js's server. Never 3111-3126. */

"use strict";
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORTS = String(process.env.TEST_PORTS || "3641,3642,3643,3644").split(",").map(Number);
if (PORTS.some((p) => p >= 3111 && p <= 3126)) { console.error("refusing: 3111-3126 are the live servers"); process.exit(2); }

const FAST = { BOT_MS: "5", TURN_MS: "600000", GOAL_PAUSE_MS: "400", PLAYBACK_SCALE: "20", TEST_HOOKS: "1" };
const SERVERS = {
  fast: { port: PORTS[0], env: FAST },
  turn: { port: PORTS[1], env: { ...FAST, TURN_MS: "1500", AFK_MS: "300", GOAL_PAUSE_MS: "100", PING_INTERVAL_MS: "4000", PING_TIMEOUT_MS: "3000" } },
  waiting: { port: PORTS[3], env: FAST },
};

function free(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(port, "127.0.0.1");
  });
}
function listening(port) {
  return new Promise((res) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => { c.destroy(); res(true); });
    c.once("error", () => res(false));
  });
}
function runNode(file, env, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...(args || [])], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  return r.status === 0;
}

(async () => {
  const children = [];
  const stopAll = () => { for (const c of children) try { c.kill("SIGTERM"); } catch (_) {} };
  process.on("exit", stopAll);
  let ok = true;

  ok = runNode("physics.js", {}) && ok;
  ok = runNode("bots.js", {}) && ok;
  ok = runNode("plus.js", {}) && ok;
  ok = runNode("moderation.js", {}) && ok;
  ok = runNode("pacing.js", { TEST_PORT: String(PORTS[0]), TEST_PORT_INPROC: String(PORTS[1]) }) && ok;   // starts its own server (before the others do), and requires one in process
  if (!(await free(PORTS[2]))) { console.error(`port ${PORTS[2]} is busy`); process.exit(2); }
  ok = runNode("reactions.js", { TEST_PORT3: String(PORTS[2]) }) && ok;   // starts its own server
  ok = runNode("gear.js", { TEST_PORT_GEAR: String(PORTS[2]) }) && ok;      // gear (2026-11-09): starts its own server on the same port, after reactions.js has let it go

  for (const [name, s] of Object.entries(SERVERS)) {
    if (!(await free(s.port))) { console.error(`port ${s.port} (${name}) is busy: not starting a server there`); process.exit(2); }
    const c = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, ...s.env, PORT: String(s.port) }, stdio: ["ignore", "ignore", "inherit"] });
    children.push(c);
  }
  for (const s of Object.values(SERVERS)) {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await listening(s.port); if (!up) await new Promise((r) => setTimeout(r, 100)); }
    if (!up) { console.error(`server on ${s.port} never came up`); stopAll(); process.exit(2); }
  }

  ok = runNode("rules.js", { URL: `http://localhost:${SERVERS.fast.port}`, URL_TURN: `http://localhost:${SERVERS.turn.port}` }) && ok;
  ok = runNode("waiting.js", { TEST_PORT: String(SERVERS.waiting.port) }) && ok;

  stopAll();
  console.log(ok ? "all suites green" : "SOME SUITES FAILED");
  process.exit(ok ? 0 : 1);
})();
