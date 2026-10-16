/*
 * The game of Flood-It, with no display in it: a board, a region and the
 * flood between them.  `MainForm` draws this and forwards the clicks; every
 * question about the game -- how many moves are left, whether it was won,
 * what a colour would swallow -- is answered here.
 *
 * A board is `n × n` cells, each born one of a few colours, and one region:
 * the cells already flooded.  It starts as the blob of the top-left corner
 * and is always one connected shape of one colour.  A move repaints that
 * region with a colour and then swallows every neighbour waiting in the same
 * colour, transitively -- which is the whole game, and the reason one move
 * can be worth twelve cells or one.
 *
 * Three things here are decisions and not detail:
 *
 *   - **The region is a mark over `cells`, and `cells` is never rewritten.**
 *     The board under the flood stays exactly as it was dealt, so a restart
 *     is a clearing of the marks and nothing has to be remembered; drawing a
 *     cell is one `region[at] ? color : cells[at]` later.
 *   - **`hint` is the greedy move, and `board` deals until greedy fits the
 *     limit.**  A board dealt at random can be impossible inside any fixed
 *     limit; this one is kept only when *take the colour that swallows the
 *     most, right now* can finish it inside the moves it comes with.  A
 *     person then has room to think, and the deal loop almost never rejects.
 *   - **`pick` answers whether it was a move.**  Pressing the colour the
 *     region already is does nothing and costs nothing; the original game
 *     takes the move away, which reads as a bug from a desktop.
 */
"use strict";

class Flood {

    /* Board(n, colors, limit, cells): the game as it was dealt.  A board is
     * built by `board`, below, which is also the one that may refuse it. */
    constructor(n, colors, limit, cells) {
        this.n      = n;
        this.colors = colors;
        this.limit  = limit;
        this.cells  = cells;

        this.reset();
    }

    /* A board comes to be by dealing cells at random, over and over, and
     * keeping the first one the greedy player finishes inside the limit.
     * The `n` and the limit are the size's own, chosen in `MainForm`.  The
     * loop is bounded; what falls out at the end of it is the best board
     * dealt, and with the real sizes it drops about one board in fifteen,
     * so that fallback is not a branch anything reaches.
     */
    static board(n, colors, limit) {
        let best = null, fewest = n * n + 1;

        for (let tries = 0; tries < 40; tries++) {
            const cells = [];
            for (let i = 0; i < n * n; i++) cells.push(Math.floor(Math.random() * colors));

            const board = new Flood(n, colors, limit, cells);
            const moves = board.greedy();

            if (moves <= limit) return board;
            if (moves < fewest) { fewest = moves; best = board; }
        }
        return best;
    }

    /* Back to the first move: the board is left alone, only the region
     * starts over.  The top-left corner is where Flood-It starts, because a
     * corner has two edges to spread along instead of three to spread away
     * from. */
    reset() {
        this.region = new Array(this.cells.length).fill(0);
        this.region[0] = 1;
        this.color  = this.cells[0];
        this.filled = 1;
        this.moves  = 0;

        this.grow();
    }

    /* Play a colour.  Answers whether it was a move at all: the colour the
     * region already wears, or anything after the end, is not one. */
    pick(color) {
        if (this.over() || color === this.color) return false;

        this.color  = color;
        this.moves += 1;
        this.grow();
        return true;
    }

    /* The flood: every unmarked cell of the region's colour that touches a
     * marked one is marked, and its own neighbours are visited in turn.  One
     * breadth-first walk, seeded with the region -- which is why a move
     * cannot leave an island behind: everything reachable in the new colour
     * is reached in the same walk. */
    grow() {
        this.filled += this.absorb(this.region, this.color);
    }

    /* The walk itself, over a region handed in: `grow` passes the real one,
     * `hint` a copy.  Answers how many cells joined. */
    absorb(region, color) {
        const n = this.n;
        const queue = [];
        let added = 0;

        for (let i = 0; i < this.cells.length; i++) if (region[i]) queue.push(i);

        for (let head = 0; head < queue.length; head++) {
            const i = queue[head];
            const x = i % n;
            const y = (i - x) / n;

            if (x > 0     && this.take(region, queue, i - 1, color)) added++;
            if (x < n - 1 && this.take(region, queue, i + 1, color)) added++;
            if (y > 0     && this.take(region, queue, i - n, color)) added++;
            if (y < n - 1 && this.take(region, queue, i + n, color)) added++;
        }
        return added;
    }

    take(region, queue, at, color) {
        if (region[at] || this.cells[at] !== color) return false;

        region[at] = 1;
        queue.push(at);
        return true;
    }

    /* The greedy move: the colour that would swallow the most cells right
     * now, or -1 on a finished board.  It is a decent player and not a
     * solver -- which is the point: the limit is measured against decent. */
    hint() {
        if (this.won()) return -1;

        let best = -1, most = -1;
        for (let color = 0; color < this.colors; color++) {
            if (color === this.color) continue;

            const gain = this.absorb(this.region.slice(), color);
            if (gain > most) { most = gain; best = color; }
        }
        return best;
    }

    /* How many moves the greedy player needs on this board, asked without
     * playing it: a copy takes the walk, and the copy's own limit is lifted
     * so a `lost` cannot stop it and pass an impossible board as a short one.
     * `board` keeps a board only when this fits. */
    greedy() {
        const sim = this.copy();
        sim.limit = sim.cells.length;
        let moves = 0;

        while (!sim.won() && moves <= sim.cells.length) {
            sim.pick(sim.hint());
            moves += 1;
        }
        return sim.won() ? moves : sim.cells.length + 1;
    }

    copy() {
        const copy = new Flood(this.n, this.colors, this.limit, this.cells.slice());

        copy.region = this.region.slice();
        copy.color  = this.color;
        copy.filled = this.filled;
        copy.moves  = this.moves;
        return copy;
    }

    won()  { return this.filled === this.cells.length; }
    lost() { return !this.won() && this.moves >= this.limit; }
    over() { return this.won() || this.lost(); }

    /* Moves left, `0` included -- what the status line shows. */
    left() { return Math.max(0, this.limit - this.moves); }
}
