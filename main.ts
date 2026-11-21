// Roomwise — a Sokoban solver for make.fun's sokoban-solver-01.
//
// Every level here is a hallway with independent rooms off it: a box pushed
// out of its room's door can never be pushed back, so each room is a problem
// of its own and the level's push-optimum is the sum of its rooms' optima.
// This solver cuts the level into rooms and solves each one push-optimally
// with a breadth-first search over pushes (a state is the boxes plus the
// player's reachable region), pruning dead squares and frozen 2x2 blocks,
// then joins the rooms' move strings with the walks between them.
//
// Deterministic by construction: every budget is counted in states kept,
// never in wall-clock time, and ties break by fixed square order, so two
// runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Work budgets, in states kept: one room's search never keeps more than this,
// and a whole-level fallback search never keeps more than the other.
const ROOM_STATES = 300_000;
const WHOLE_STATES = 1_000_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

type Board = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** XSB text to a board: walls (short rows and the outer frame read as walls), goals, boxes, player. */
function parse(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares a box can ever sit on: the goals, plus every square a box can be pulled back from one, one square at a time. */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const y = x - d; // a box on y can be pushed onto x when the player can stand on y - d
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Each square's walking distance to the nearest goal, around walls alone (-1 where no goal is reachable). */
function goalDistances(w: number, wall: Uint8Array, goals: number[]): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** The lowest square of the region the player reaches from `from` around walls and `occupied`, marking `seen` with `stamp`. */
function regionLow(
  w: number, wall: Uint8Array, occupied: Uint8Array, from: number,
  seen: Int32Array, stamp: number, stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` sits in a frozen 2x2 block: four squares of walls and boxes, a box among them off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and `occupied`, in lower LURD letters ('' when already there). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = LETTER[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of one board: a breadth-first search over pushes.
 * A state is the boxes' squares and the player's reachable region (named by
 * its lowest square); expanding in order of pushes made, the first solved
 * state met is push-optimal. Pushes are tried in order of a lower bound on
 * the pushes still needed (each box's distance to its nearest goal, summed),
 * so the goal is met early within its depth. Returns the moves, or null when
 * the search gives up (or the board has no solution).
 */
function solvePushes(board: Board, maxStates: number): string | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  const dist = goalDistances(w, wall, goals);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (board.boxes.some((b) => !live[b])) return null;

  const sBoxes: number[][] = [board.boxes.slice()];
  const sPlayer: number[] = [board.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const index = new Map<string, number>();
  for (const b of board.boxes) occupied[b] = 1;
  index.set(`${regionLow(w, wall, occupied, board.player, seen, ++stamp, stack)}|${board.boxes.join(',')}`, 0);
  for (const b of board.boxes) occupied[b] = 0;
  let found = solved(board.boxes) ? 0 : -1;

  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    regionLow(w, wall, occupied, sPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    // Every push the player can make from here, best-looking first.
    const tries: { boxes: number[]; from: number; dir: number; h: number }[] = [];
    for (const b of boxes) {
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const next = boxes.slice();
        next[next.indexOf(b)] = t;
        next.sort((a, c) => a - c);
        tries.push({ boxes: next, from: b, dir: k, h: next.reduce((a, x) => a + (dist[x]! < 0 ? 0 : dist[x]!), 0) });
      }
    }
    tries.sort((a, b) => a.h - b.h);
    for (const t of tries) {
      const { boxes: next, from, dir } = t;
      for (const b of next) occupied[b] = 1;
      const key = `${regionLow(w, wall, occupied, from, seen, ++stamp, stack)}|${next.join(',')}`;
      for (const b of next) occupied[b] = 0;
      if (index.has(key)) continue;
      if (sBoxes.length >= maxStates) {
        for (const b of boxes) occupied[b] = 0;
        return null;
      }
      index.set(key, sBoxes.length);
      sBoxes.push(next);
      sPlayer.push(from);
      sParent.push(head);
      sFrom.push(from);
      sDir.push(dir);
      if (solved(next)) {
        found = sBoxes.length - 1;
        break;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const d = DY[sDir[s]!]! * w + DX[sDir[s]!]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += LETTER[sDir[s]!]!;
    player = from;
    boxes[boxes.indexOf(from)] = from + d;
    boxes.sort((a, b) => a - b);
  }
  return moves;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds boxes is a room, with its boxes and goals. Null when some part holds
 * more or fewer boxes than goals, a goal falls outside every part, or a box
 * starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(board: Board): { boxes: number[]; goals: number[]; done: boolean }[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i]! + DY[k]! * w + DX[k]!;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** A level's moves: each room solved push-optimally in turn, the player walking on from where the last room left it. */
function solveLevel(text: string): string {
  const board = parse(text);
  const rooms = roomsOf(board);
  if (rooms === null) return solvePushes(board, WHOLE_STATES) ?? '';
  let player = board.player;
  let moves = '';
  for (const room of rooms) {
    const subWall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) subWall[b] = 1;
    }
    const solved = solvePushes(
      { w: board.w, h: board.h, wall: subWall, goals: room.goals.slice().sort((a, b) => a - b), boxes: room.boxes.slice().sort((a, b) => a - b), player },
      ROOM_STATES,
    );
    if (solved === null) return '';
    moves += solved;
    player = endOf(board.w, player, solved);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
