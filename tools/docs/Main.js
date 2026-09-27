/*
 * tools/docs: writes the rows of docs/llm and docs/reference from the
 * descriptions beside each member in the code. See Rows.js.
 *
 *   tools/docs.sh           write the pages that are out of date
 *   tools/docs.sh --check   say which, and fail, writing nothing
 */
function Main() {
    const args  = Application.Arguments;
    const check = args.includes("--check");
    const root  = args.find((a) => !a.startsWith("--")) || File.Directory(File.Directory(Application.Directory));
    const pages = docRows(root);
    const names = Dictionary.Keys(pages);

    for (const page of names) {
        if (check) print(`${page}: rows out of date`);
        else { File.Save(File.Join(root, page), pages[page]); print(`${page}: written`); }
    }
    if (!names.length) print("docs: every row says what the code says");
    Application.Quit(check && names.length ? 1 : 0);
}
