"use strict";

/*
 * Two errors nobody catches, after `Main` has returned: the handler gets the
 * message and the stack as two strings, in both hosts, and the run still ends
 * with status 1. The second is a name the language took away, and the
 * sentence that names its replacement reaches the handler too.
 */
function Main() {
    Application.OnError = (message, stack) =>
        print(`handled: ${message} | stack names the file: ${stack.includes("Main.js")}`);
    Timer.After(0, () => { throw new Error("from a timer"); });
    Timer.After(10, () => { setTimeout(1); });
}
