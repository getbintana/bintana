/*
 * Controls placed by hand, read back as rows, columns and grids.
 *
 * A `Fixed` form is N controls and N anchoring decisions, and getting one of
 * them wrong is invisible at the size the form was drawn at (see "Laying out a
 * form" in docs/agents/layout.md). What the designer offers is to take a
 * drawing and give back the boxes it was a picture of. This file is the half
 * that has no controls in it: rectangles in, a tree out, so it can be asked
 * and tested without a form.
 *
 * **The cut is the classic XY-cut** of document layout analysis: split into
 * horizontal bands wherever nothing straddles the gap, and each band into
 * columns the same way, recursively. Two refinements make the result read like
 * something a person would have built:
 *
 * - **Consecutive rows with the same columns, lined up, are a `Grid`** -- the
 *   labels-and-fields block that every data-entry form is, and that a column
 *   of rows would draw with the fields no longer in line once a label is
 *   translated.
 * - **A gap much bigger than the others splits a row into a start group and an
 *   end group**, the end one expanding and aligned to the end: the Help ...
 *   OK Cancel row of a dialog, and a column whose buttons sit at the bottom.
 *
 * Where nothing can be cut (controls overlapping on both axes) the group stays
 * a `Fixed` panel with the coordinates it had: a partial answer is better than
 * a guess, and the rest of the tree is still boxes.
 *
 * What it decides about each child is **where it sits in its cell**, which is
 * the one thing a box asks that a drawing never said: a control that spanned
 * the band fills it, one that touched an edge keeps to that edge, one in the
 * middle is centred. And what grows: a control that is a view of something
 * (a list, an editor, a table) takes the room along the box's axis, and a field
 * in the last column of a grid takes the room across it.
 */
"use strict";

/* Pixels two edges may disagree by and still be "the same edge" -- the
 * designer's snap, so two controls aligned by the snap always count. */
const ARRANGE_TOL = 4;

/* A gap counts as a break between a start group and an end group when it is at
 * least this... */
const ARRANGE_BREAK_MIN = 24;
/* ...and this many times the next widest gap in the same row or column. */
const ARRANGE_BREAK_RATIO = 3;

export class Arrange {

    /*
     * `items` are `{ key, x, y, w, h, grows, field }` in one coordinate space;
     * `frame` is the room the result will be laid out in (the container's
     * inside, when a container is converted in place), and the items' own
     * bounds when it is left out.
     *
     * Answers a tree of `{ kind, rect, props, ... }`:
     *
     *   Leaf   key
     *   Box    horizontal, spacing, children
     *   Grid   columns, columnSpacing, rowSpacing, children (leaves, row by row)
     *   Fixed  children: { key, x, y }, relative to the node's rect
     *
     * `props` on every node but the root is how it sits in its parent:
     * `HAlign`, `VAlign`, and `HExpand`/`VExpand` when it grows.
     */
    static plan(items, frame = null) {
        if (!items.length) return null;
        const root = cut(items);
        place(root, frame || root.rect);
        return root;
    }

    /* How many controls of the tree ended up still placed by coordinate: the
     * designer says so, since a `Fixed` left inside is the part not done. */
    static fixedCount(node) {
        if (!node) return 0;
        if (node.kind === "Fixed") return node.children.length;
        if (node.kind === "Leaf") return 0;
        return node.children.reduce((n, c) => n + Arrange.fixedCount(c), 0);
    }
}

/* --- the cut --------------------------------------------------------------- */

function union(rects) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
        x0 = Math.min(x0, r.x);       y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function lo(r, horizontal) { return horizontal ? r.x : r.y; }
function hi(r, horizontal) { return horizontal ? r.x + r.w : r.y + r.h; }

/*
 * The items in bands along one axis: a new band starts where nothing reaches
 * past its start by more than the tolerance. Rows when `horizontal` is false
 * (bands stacked down the page), columns when it is true.
 */
function bands(items, horizontal) {
    const sorted = items.slice().sort((a, b) => lo(a, horizontal) - lo(b, horizontal));
    const out = [];
    let end = -Infinity;
    for (const it of sorted) {
        if (out.length && lo(it, horizontal) < end - ARRANGE_TOL) {
            out[out.length - 1].push(it);
            end = Math.max(end, hi(it, horizontal));
        } else {
            out.push([it]);
            end = hi(it, horizontal);
        }
    }
    return out;
}

function leaf(it) {
    return { kind: "Leaf", key: it.key, rect: { x: it.x, y: it.y, w: it.w, h: it.h },
             grows: !!it.grows, field: !!it.field, widens: !!it.field, props: {} };
}

/* A row's cells, when it is one item per column and at least two columns. */
function cellsOf(row) {
    const cols = bands(row, true);
    if (cols.length < 2 || cols.some((c) => c.length !== 1)) return null;
    return cols.map((c) => c[0]);
}

/* Whether these rows are one grid: the same number of cells, and each column's
 * cells sharing at least one x -- the test for "lined up" that both
 * left-aligned and right-aligned labels pass. */
function oneGrid(rows) {
    const cells = rows.map(cellsOf);
    if (cells.some((c) => !c)) return false;
    const k = cells[0].length;
    if (cells.some((c) => c.length !== k)) return false;
    for (let j = 0; j < k; j++) {
        const start = Math.max(...cells.map((c) => c[j].x));
        const end   = Math.min(...cells.map((c) => c[j].x + c[j].w));
        if (start > end) return false;
    }
    return true;
}

function cut(items) {
    if (items.length === 1) return leaf(items[0]);

    const rows = bands(items, false);
    if (rows.length > 1) {
        const parts = [];
        for (let i = 0; i < rows.length; ) {
            let j = i + 1;
            while (j < rows.length && oneGrid(rows.slice(i, j + 1))) j++;
            parts.push(j - i >= 2 ? grid(rows.slice(i, j)) : cut(rows[i]));
            i = j;
        }
        return parts.length === 1 ? parts[0] : line(parts, false);
    }

    const cols = bands(items, true);
    if (cols.length > 1) return line(cols.map(cut), true);

    return fixed(items);
}

function gapsOf(parts, horizontal) {
    const gaps = [];
    for (let i = 1; i < parts.length; i++)
        gaps.push(lo(parts[i].rect, horizontal) - hi(parts[i - 1].rect, horizontal));
    return gaps;
}

function box(parts, horizontal) {
    const gaps = gapsOf(parts, horizontal);
    return {
        kind: "Box", horizontal, props: {},
        /* The smallest gap, so nothing comes out further apart than it was
         * drawn; a wider gap elsewhere is lost, and the break below keeps the
         * one that mattered. */
        spacing: Math.max(0, Math.round(Math.min(...gaps))),
        rect: union(parts.map((p) => p.rect)),
        grows: parts.some((p) => p.grows),
        widens: parts.some((p) => p.widens),
        children: parts,
    };
}

/* A row or a column, split at its break when it has one. */
function line(parts, horizontal) {
    const gaps = gapsOf(parts, horizontal);
    let at = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i] > gaps[at]) at = i;
    const rest = gaps.filter((g, i) => i !== at);
    const next = rest.length ? Math.max(...rest) : 0;

    if (gaps[at] >= ARRANGE_BREAK_MIN &&
        gaps[at] >= ARRANGE_BREAK_RATIO * Math.max(next, ARRANGE_TOL)) {
        const head = parts.slice(0, at + 1);
        const tail = parts.slice(at + 1);
        const start = head.length > 1 ? box(head, horizontal) : head[0];
        const end   = tail.length > 1 ? box(tail, horizontal) : tail[0];
        end.atEnd = true;
        const outer = box([start, end], horizontal);
        /* The break itself is the end group's to absorb, so the box keeps the
         * small gap -- what the two groups would be apart if squeezed. */
        outer.spacing = Math.max(0, Math.round(next));
        return outer;
    }
    return box(parts, horizontal);
}

function grid(rows) {
    const cells = rows.map(cellsOf);
    const k = cells[0].length;

    const colLo = [], colHi = [];
    for (let j = 0; j < k; j++) {
        colLo.push(Math.min(...cells.map((c) => c[j].x)));
        colHi.push(Math.max(...cells.map((c) => c[j].x + c[j].w)));
    }
    let columnSpacing = Infinity;
    for (let j = 1; j < k; j++) columnSpacing = Math.min(columnSpacing, colLo[j] - colHi[j - 1]);

    const rowRects = rows.map((r) => union(r));
    let rowSpacing = Infinity;
    for (let i = 1; i < rowRects.length; i++)
        rowSpacing = Math.min(rowSpacing, rowRects[i].y - (rowRects[i - 1].y + rowRects[i - 1].h));

    const children = [];
    cells.forEach((row, i) => row.forEach((it, j) => {
        const l = leaf(it);
        l.cell = { x: colLo[j], w: colHi[j] - colLo[j], y: rowRects[i].y, h: rowRects[i].h,
                   last: j === k - 1 };
        children.push(l);
    }));

    return {
        kind: "Grid", columns: k, props: {},
        columnSpacing: Math.max(0, Math.round(columnSpacing)),
        rowSpacing: Math.max(0, Math.round(rowSpacing)),
        rect: union(rows.flat()),
        grows: children.some((c) => c.grows),
        widens: children.some((c) => c.cell.last && c.field),
        children,
    };
}

function fixed(items) {
    const rect = union(items);
    return {
        kind: "Fixed", rect, props: {}, grows: items.some((it) => it.grows),
        children: items.map((it) => ({ key: it.key, x: it.x - rect.x, y: it.y - rect.y })),
    };
}

/* --- where each child sits ------------------------------------------------- */

/* Where [s, e] sits inside the band [a, b]. */
function alignIn(s, e, a, b) {
    const atStart = s <= a + ARRANGE_TOL;
    const atEnd   = e >= b - ARRANGE_TOL;
    if (atStart && atEnd) return "Fill";
    if (atStart) return "Start";
    if (atEnd) return "End";
    if (Math.abs((s + e) / 2 - (a + b) / 2) <= ARRANGE_TOL) return "Center";
    return "Start";
}

function place(node, band) {
    if (node.kind === "Box") {
        const h = node.horizontal;
        for (const c of node.children) {
            /* Across the box: where it was in the band. */
            const across = h
                ? alignIn(c.rect.y, c.rect.y + c.rect.h, band.y, band.y + band.h)
                : alignIn(c.rect.x, c.rect.x + c.rect.w, band.x, band.x + band.w);
            c.props[h ? "VAlign" : "HAlign"] = across;
            /* Along it: the end group takes the slack and keeps to the end; a
             * view of something takes the slack and fills it. */
            if (c.atEnd) {
                c.props[h ? "HExpand" : "VExpand"] = true;
                c.props[h ? "HAlign" : "VAlign"] = "End";
            } else if (c.grows) {
                c.props[h ? "HExpand" : "VExpand"] = true;
                c.props[h ? "HAlign" : "VAlign"] = "Fill";
            }
            /* A field, or a group with one, takes the width a wider window
             * brings: along a row, and across a column when it is a group (a
             * lone field narrower than its column was drawn that way). */
            if (c.widens && !c.atEnd) {
                if (h && !c.grows) { c.props.HExpand = true; c.props.HAlign = "Fill"; }
                if (!h && c.kind !== "Leaf") c.props.HAlign = "Fill";
            }
            place(c, c.rect);
        }
    } else if (node.kind === "Grid") {
        for (const c of node.children) {
            const cell = c.cell;
            c.props.HAlign = alignIn(c.rect.x, c.rect.x + c.rect.w, cell.x, cell.x + cell.w);
            c.props.VAlign = alignIn(c.rect.y, c.rect.y + c.rect.h, cell.y, cell.y + cell.h);
            /* The field in the last column is what a wider window is for. */
            if (cell.last && (c.field || c.grows) && c.props.HAlign !== "End") {
                c.props.HAlign  = "Fill";
                c.props.HExpand = true;
            }
            if (c.grows) {
                c.props.VAlign  = "Fill";
                c.props.VExpand = true;
            }
            /* A cell's column is as wide as what is in it, and a child that
             * fills asks for its MinWidth and not its Width
             * (bta_widget_relayout): the drawn size is the floor, or a label
             * column drawn 80 wide collapses to its text. Not on an axis it
             * expands along, where the room is whatever is left -- and not in
             * a box, whose cross size its parent gives it. */
            if (c.props.HAlign === "Fill" && !c.props.HExpand) c.props.MinWidth = c.rect.w;
            if (c.props.VAlign === "Fill" && !c.props.VExpand) c.props.MinHeight = c.rect.h;
        }
    }
}
