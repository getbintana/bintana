/*
 * A library a worker can import, and the reason it can: both files are
 * modules with a pure class in them.  `xlsx` is one file; `qr` has its view in
 * a script beside `QrCode.js`, and the module loader skips a script.  Neither
 * class touches GTK, the loop or the main thread's catalogue.
 */
import { Xlsx } from "xlsx";
import { QrCode } from "qr";

export class LibraryTask extends Task {
    Run(msg) {
        const sheets = Xlsx.Write(msg.path, [{
            Name:    "S",
            Columns: [{ Name: "A", Kind: "text" }],
            Rows:    [["written in a worker"]],
        }]);
        const qr = QrCode.Encode("hola");

        return {
            sheets:    sheets,
            size:      File.Info(msg.path).Size,
            qrSize:    qr.Size,
            qrVersion: qr.Version,
        };
    }
}
