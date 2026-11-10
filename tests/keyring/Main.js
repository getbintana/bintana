function Main() {
    print(`Provider=${Keyring.Provider}`);

    if (Keyring.Provider !== "File") {
        print("NOT_FILE");
        Application.Quit(2);
        return;
    }

    Keyring.Store("service", "key", "value-✓", (ok) => {
        print(`STORE=${ok}`);
        Application.Quit(ok ? 0 : 3);
    });
}
