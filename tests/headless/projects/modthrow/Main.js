"use strict";

/* A module (it exports), and it throws while it is evaluated. The run must
 * stop with the error on stderr and exit 1, never exit 1 in silence. */
export function Main() {
    print("never reached");
}

throw new Error("thrown while the module loads");
