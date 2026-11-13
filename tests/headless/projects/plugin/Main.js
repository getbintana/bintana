"use strict";

/* `TestPlug` is the suite's reference plugin: a `.so` in a library directory,
 * loaded before `rad.js`, and the library's JavaScript would wrap it. */
function Main() {
    print("plugin:" + TestPlug.Echo("ok"));
}
