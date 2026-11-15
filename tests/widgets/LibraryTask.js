/*
 * A library a worker can import, and the reason it can: both files are
 * modules with a pure class in them.  `xlsx` is one file; `qr` has its view in
 * a script beside `QrCode.js`, and the module loader skips a script.  Neither
 * class touches GTK, the loop or the main thread's catalogue.
 *
 * **The workbook half needs libxml2, which is optional at build time**, so what
 * `Write` refuses is reported instead of letting the whole task fail: the QR
 * below still proves that a library crossed into the worker, and the test
 * asserts the sentence on a build without it.
 */
import { Xlsx } from "xlsx";
import { QrCode } from "qr";

export class LibraryTask extends Task {
    Run(msg) {
        let sheets = 0, size = 0, xlsx = "";

        try {
            sheets = Xlsx.Write(msg.path, [{
                Name:    "S",
                Columns: [{ Name: "A", Kind: "text" }],
                Rows:    [["written in a worker"]],
            }]);
            size = File.Info(msg.path).Size;
        } catch (e) {
            xlsx = e.message;
        }

        const qr = QrCode.Encode("hola");

        return {
            sheets:    sheets,
            size:      size,
            xlsx:      xlsx,
            qrSize:    qr.Size,
            qrVersion: qr.Version,
        };
    }
}
