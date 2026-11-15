# Table Soccer Rooms (self-hosted)

Turn-based flick-disc football for two (Soccer Stars / button football). Share a 6-letter room code, or play a bot
(easy, normal, hard). First to 1, 2, 3 or 5 goals, or the most goals when the clock runs out (a tie goes to a golden
goal). No ads.

Played in the GameNest app (slug `soccer`, behind the reverse proxy under `/soccer`, dev port 3124). The contract with
the app is `PROTOCOL.md` (v1, 2026-10-18; it lives with the app's work files). Everything it names is implemented as
written; this file lists what this server adds to it.

## Deviations from PROTOCOL v1

Additions (nothing was renamed or reshaped):

1. **`not_your_turn`**: a new refusal code. `flick` out of turn, or during the goal pause, answers
   `err "Not your turn." {code: "not_your_turn", op: "flick"}`. (Codes in use: `not_found`, `started`, `full`, `name`,
   `nobody`, `bad_flick`, `not_your_disc`, `not_your_turn`.) `bad_flick` is a disc that is not an integer 0-9, or an
   `aim` or `power` that is not a finite number. A disc of the other side is `not_your_disc`.
2. **`testSet`** (only when `TEST_HOOKS=1`; otherwise the event is not even registered): any seated player may put the
   match where a test needs it: `{bodies: [[x,y] x11], score: [a,b], clockMs, golden, turn, kickoff, botControlled: [bool,bool]}`
   (`clockMs`: ms from now to full time, may be negative; `botControlled` hands a human seat to a bot). Nothing else
   uses it.
3. **Env vars** `GOAL_PAUSE_MS`, `PLAYBACK_SCALE`, `CLOCK_MS_PER_MINUTE` (table below), so the suite runs fast.
4. **Event fields.** `post` carries the post index as `b` (0 = (21,0), 1 = (39,0), 2 = (21,100), 3 = (39,100)) and the
   ball's body index 10 as `a`. `near` carries the attacking seat as `a` (the seat whose goal-line the ball is at: seat 1
   attacks y=0, seat 0 attacks y=100). `goal` carries the scoring seat as `a` (an own goal scores for the other side).
   `hit`/`kick`/`wall`/`save` carry body indices (`a`, and `b` for the second body of a pair) and `s` = impact speed 0..1.
5. **State additions**: `goalPauseEndsAt` (server ms, or null) and `players[i].level` on bots. `lastShot.power` is the
   clamped power the server used.
6. **`addBot`** accepts `{level}` (`easy`/`normal`/`hard`; anything else, or nothing, is `normal`) and answers `full`
   when the table is already two. `settings` and `addBot` are also open between matches (status `over`).
7. **`thinking`** (soccer r1, 2026-11-03; null when there is nothing to say): while a bot's flick is being got ready, `{seat, disc, aim, power, from, at}`: the disc the bot has
   picked, its aim (radians, absolute frame) and power, and the server times (ms) its pull starts (when the app's playback of the flick before it is over) and its flick lands
   (`at`). The bot's shot is worked out off the event loop from the moment the turn passes (as before), and a state is sent once it is known; the flick that follows is that one, at
   `at`. The app rings the disc, grows its aim arrow from nothing to the power between `from` and `at` and says "Striker is aiming...". A person's turn, a goal pause and a
   finished match carry null.

Interpretations where the protocol was silent (the app should know):

- **The creeping end of a flick is thinned** (pacing round 1, 2026-11-01): from the frame after which no body moves faster than `TAIL_STILL` (15 u/s) to the end, only every `TAIL_KEEP`th (3rd) frame is kept (`physics.js` `compressTail`), so the app, which plays the frames at 60 Hz and blends between them, shows the last stretch of creeping at three times the speed and ends in the same positions; events in that stretch move to the frame that is now where they happened. A flick that scores is left whole. About 0.6 s saved a flick; `TAIL_KEEP=1` turns it off. A bot's thought follows its shot (0.4-1.8 s: short for a disc near the ball, long for one far from it; a pass-bonus flick 0.55 of that) and starts, off the event loop, as soon as the turn passes.
- **The goal pause starts when the shot's playback ends**: the reset comes `frames.length / 60` s plus `GOAL_PAUSE_MS`
  after the goal flick, so the whole goal shot is seen before the celebration window. `goalPauseEndsAt` says when.
- **After a goal, `bodies` are where the last frame leaves them** (the ball in the net, other bodies possibly still
  rolling: the shot shows the net for 0.5 s after the goal, then ends). They are not at rest; the reset replaces them.
- The turn clock starts after the last shot's playback (`TURN_MS` of thinking time on top of it), as PROTOCOL says.
- **The match clock** (`clockEndsAt`) runs continuously from the start, through playback and goal pauses. It is checked
  at the end of a flick (and after a goal), never in the middle of one: leader wins, tied sets `golden: true`.
- **Who kicks off a rematch alternates** (match 1: seat 0, match 2: seat 1, ...). After a goal the conceding side does.
- **Leaving** (`leave`) in the lobby takes the seat away at once and passes the host to the other human. Mid-match it
  forfeits to a human opponent (`status: "over"`, `winner` = the other seat) unless someone is waiting in the line, who
  takes the leaver's side with the score as it stands. A room with no human left is closed. A plain disconnect is not a
  leave: the seat waits, the AFK clock (`AFK_MS`) plays for it, and the same `playerId` gets it back.
- `rematch` needs two players (counting the waiting line), else `nobody`.
- A player whose turn clock runs out gets an "easy" bot's flick; the third in a row hands the seat to a "normal" bot until
  the player flicks or sends `takeSeat` (golf's policy).
- Chat and names are hardened against non-string payloads (`{text: {toString: 1}}` throws in golf's `String()`).

## The server owns the physics

A client sends only `flick {disc, aim, power}`. The server runs every body (`physics.js`: a fixed 120 Hz step, four
collision substeps each, frames sampled at 60 Hz, no `Math.random`) and broadcasts the whole shot in `lastShot`. The app
plays it back. Nothing about where a disc or the ball ends up is the client's to decide.

| Piece | What |
|---|---|
| `physics.js` | `PHYS` and `simulate(bodies, disc, aim, power, opts)` returning `{frames, events, result, goalFor?, end}`; `formation(kickoffSeat)`; `freeTravel`. `opts.light` skips frames and events (a bot's practice swing); `opts.onStep` is for tests. |
| `server.js` | Rooms, turns, goals and the pause, the match clock and golden goal, bots and the AFK policy, chat / voice / push / waiting line / heartbeat / refusals as in Mini Golf. |
| `bots.js`, `bot-worker.js` | `botFlick(bodies, seat, level, rng)` and a worker-thread pool around it (a dead or slow worker falls back to the main thread). Seedable. |
| `reactions.js`, `plus.js`, `moderation*.js` | Copied verbatim from Mini Golf. Moderation loads its model from `~/Library/GameNest/Cache`; without it the word list alone runs. |
| `test/physics.js` | Determinism, containment (goal boxes too), no tunnelling at full power, energy never grows, goals (a ball on the line is not one), posts, the formation, every body stops, frame and event shape, the feel numbers. |
| `test/bots.js` | Legal flicks at every level, seeds, easy's error and power, hard scoring from a set-up, a whole headless match, the pool (answers, dead and hung workers). |
| `test/rules.js` | Real socket clients: rooms, settings, bots, refusals, goals and the reset, first to N, the clock and golden goal, timeouts, AFK, rematch, leave, hostile payloads, one socket one room, names, chat and voice, a whole bot-vs-bot match. |
| `test/waiting.js`, `reactions.js`, `plus.js`, `moderation.js` | The shared suites (waiting line, stickers, Plus, moderation), adapted to a table of two. |

## Run it

```bash
npm install
node server.js                                          # http://localhost:3000
BASE_PATH=/soccer PORT=3124 TEST_HOOKS=1 node server.js   # the dev server, behind a reverse proxy path
```

## Tests

```bash
npm test                                   # starts its own servers on 3641-3644
TEST_PORTS=3652,3653,3654,3655 npm test    # or on other ports (never 3111-3123)
```

## Settings

| Env | Default | What |
|---|---|---|
| `PORT`, `BASE_PATH` | 3000, none | listen port; mount path (`/soccer`) |
| `TURN_MS` | 15000 | a turn's clock, after the last shot's playback |
| `AFK_MS` | 6000 | the clock for a player who is not connected |
| `BOT_MS` | 1200 | scales a bot's think time (easy 0.7-1.3 s, normal 1.0-1.6 s, hard 0.8-1.8 s at 1200) |
| `GOAL_PAUSE_MS` | 1300 | the goal celebration (the app's goal moment is 1.2 s), after the shot's playback, before the reset (2600 before soccer r1) |
| `PLAYBACK_SCALE` | 1 | divides every wait that stands for "the app is playing the shot" (turn clock start, bot delay, goal pause). Tests use 20 |
| `CLOCK_MS_PER_MINUTE` | 60000 | the match clock's minute, so tests need not wait minutes |
| `SHOT_LEEWAY_MS` | 250 | how far back a client may date a flick (`flick.at`) |
| `TEST_HOOKS` | off | `1` registers `testSet` |
| `BOT_WORKERS` | cores - 1, at most 4 | bot-thinking threads; 0 thinks on the main thread |
| `BOT_JOB_TIMEOUT_MS` | 2000 | a worker slower than this is answered on the main thread |
| `PING_INTERVAL_MS`, `PING_TIMEOUT_MS` | socket.io's 25000, 20000 | the heartbeat |
| `PUSH_URL` | none | the push relay (`/notify`) |
| `REACTIONS_DEFAULT`, `REACT_MS`, `REACT_BOTS_ALWAYS` | on, 1500, off | reactions.js (`REACT_BOTS_ALWAYS=1` is for tests) |

## Physics numbers (`PHYS`)

Pitch 60 x 100 u, goal mouths x 21..39 with boxes 6 deep, posts r 0.9, discs r 4 (mass 5), ball r 2.2 (mass 1).

| | |
|---|---|
| Full flick (power 1) | 133 u/s; power is linear from 0.05 (a tap) to 1 |
| Damping per 120 Hz step | discs 0.992, ball 0.990, plus constant friction 10 and 5 u/s^2 |
| Restitution | disc-wall 0.75, ball-wall 0.85, disc-disc 0.90, disc-ball 0.90, post 0.80 |
| Stop | below 0.25 u/s a body snaps to 0; a turn ends when all have stopped, on a goal (plus a 0.5 s tail), or at 9 s |
| Feel | a lone disc at full power rolls 110 u in 2.7 s; half power 48 u; a ball struck from the centre spot reaches the far goal from 41 % power; typical turns settle in 2-2.5 s, a full-power one with collisions up to ~4 s |

## Rules

- Seat 0 defends y=0 and attacks y=100; seat 1 the reverse. Seat 0 kicks off match 1.
- Kick-off: the other side's discs stay out of the centre circle (r 12); the kicking side's front pair steps up.
- A goal is scored when the ball's centre is more than its radius past the line, inside the mouth. A ball on the line is
  not a goal. Own goals count for the other side.
- Each turn is one flick of one of your own discs. A turn ends when everything has stopped.
- First to `opts.goals` wins, or when the match clock has run out at the end of a flick the leader wins; if it is level
  the next goal wins (golden goal).
- A flick not made in `TURN_MS` is made for you (an easy bot's); three in a row and a bot plays your side until you act.

## Notes

- Rooms live in memory; a restart loses open rooms.
- Empty rooms are cleaned up after two hours.
