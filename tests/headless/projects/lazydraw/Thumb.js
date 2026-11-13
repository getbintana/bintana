"use strict";

/* A worker that draws before the main thread has: it must get `Bitmap`, as a
 * worker in the graphical host does. The core loads the module on the main
 * thread when the task starts, so the worker's class is numbered by the main
 * runtime first. */
class Thumb extends Task {
    Run(path) {
        const b = Bitmap.Load(path);
        return `${b.Width}x${b.Height}`;
    }
}
