"use strict";

/*
 * Every string here is assigned to `Painter.Color` in a 2x1 drawing: one
 * pixel painted with it over an opaque one that is not, so the alpha shows.
 * What is printed is whether the assignment was taken and, if it was, the
 * first sample that drew the same PNG -- an equality, which holds on any
 * machine, where a hash of the bytes would move with zlib. `expected.txt` is
 * what GDK answered on 2026-11-13 (GTK 4.20), when both hosts still asked it;
 * `tests/headless.sh` holds both hosts to it.
 */
const SAMPLES = [
    "red", "Red", "  red  ", "rebeccapurple", "transparent", "notacolour",
    "#f00", "#f008", "#ff0000", "#ff000080", "#ff0000zz", "#ff00", "#fffff",
    "#", "#F0a", " #ff0000", "#ff0000 ",
    "rgb(255,0,0)", "rgb(255, 0, 0)", "rgb( 255 , 0 , 0 )", "rgb(100%,0%,0%)",
    "rgb(300,-5,0)", "rgb(255,0,0) x", "rgb(255,0)", "rgb(255 0 0)",
    "rgba(255,0,0,0.5)", "rgba(255,0,0,50%)", "rgba(255,0,0,2)", "rgba(255,0,0)",
    "RGB(255,0,0)", "rgb(255.5,0,0)",
    "hsl(0,100%,50%)", "hsl(120, 100%, 25%)", "hsla(240,100%,50%,0.5)",
    "hsl(0,100,50)", "hsl(360,100%,50%)", "hsl(-120,100%,50%)",
    "hsla(0,100%,50%)",
    "#fff000fff", "#ffff00000000", "#ff0000ff00",
    "rgba(255,0,0,.5)", "rgb(255,0,0,0.5)", "rgba (255,0,0,1)", "rgb(255,0,0",
    "rgba(255,0,0,-1)", "rgb(50%,255,0)", "rgb(1e2,0,0)", "rgb(+255,0,0)",
    "hsl(0,100%,50%,0.5)", "hsla(0,100%,50%,50%)", "hsl(0deg,100%,50%)",
    "hsl(0, 150%, 50%)", "hsl(0,100%,120%)", "hsla(0,100%,50%,2)", "HSL(0,100%,50%)",
    "hsl(30.5,50.5%,40.5%)", "white", "WHITE", "grey", "gray50", "lightgoldenrodyellow",
    "", " ",
    /* References: the same colours written as rgb(), so a sample that is
     * the only one of its colour above still lands in a class here. */
    "rgb(102,51,153)", "rgb(0,127.5,0)", "rgba(0,0,255,0.5)", "blue",
    "rgb(155.43,104.14,51.12)", "rgb(127,127,127)", "rgb(250,250,210)",
    "rgb(128,128,128)", "rgb(255,0,170)", "magenta", "rgb(127.5,255,0)", "rgb(100,0,0)",
    "rgba(255,0,0,0.533)", "rgba(255,255,0,0)", "rgb(255,255,255)",
];

function sample(text) {
    let taken = true;
    const png = Drawing.ToPng(2, 1, (p) => {
        p.Color = "#00ff00";
        p.Rectangle(0, 0, 2, 1);
        p.Fill();
        try {
            p.Color = text;
        } catch (e) {
            taken = false;
            return;
        }
        p.Rectangle(0, 0, 1, 1);
        p.Fill();
    });
    return taken ? Hash.Sha256(png) : null;
}

function Main() {
    const first = new Map();     /* hash -> the first sample that drew it */

    for (const text of SAMPLES) {
        const hash = sample(text);
        if (hash === null) {
            print(`${JSON.stringify(text)}: refused`);
            continue;
        }
        if (!first.has(hash))
            first.set(hash, text);
        print(`${JSON.stringify(text)}: = ${JSON.stringify(first.get(hash))}`);
    }
}
