"use strict";

/* Run by the graphical host only: `Widget.Members` is what it knows about
 * `Text`, and the core's list of measurements that load the drawing module
 * must be exactly these, `LineOf` included. */
function Main() {
    print(`Text names: ${Widget.Members("Text").map((m) => m.Name).sort().join(" ")}`);
}
