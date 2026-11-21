# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Mzikky/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Mzikky/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Roomwise is a push-optimal Sokoban solver. Every level here is a hallway with independent rooms off it — a box pushed out of its room's door can never be pushed back — so the solver cuts the level into rooms and solves each one push-optimally with a breadth-first search over pushes (states are the boxes plus the player's reachable region), pruning dead squares and frozen 2×2 blocks, then joins the rooms' move strings with the walks between them. On the practice set it solves all five levels in exactly the optimal push count (score 1,000,000); the house baseline, plain A*, scores 200,000.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `MAKEFUN_OUTPUT_DIR`) for every instance. Node 22, no dependencies. Deterministic: every budget is counted in states kept, never in wall-clock time, so two runs write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=webf24xb&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
