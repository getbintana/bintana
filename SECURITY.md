# Security policy

## Reporting a vulnerability

Please report a vulnerability **privately**, through GitHub's security
advisories:

<https://github.com/getbintana/bintana/security/advisories/new>

Do not open a public issue for something that can crash a program, run code,
read files it was not given, or escape a sandbox. The advisory is visible to
the maintainers before it is published.

A useful report has:

- the runtime's release (`bintana --version`) and the platform;
- a minimal project or a few lines of Bintana that show the problem;
- what happens, and what should happen instead;
- whether it is reproducible with the current `main`.

## Scope

This policy covers the runtime in `runtime/`, the prelude in `runtime/js/`,
the libraries in `lib/`, the IDE in `ide/`, and the packaging tools in
`tools/` and `lib/package`.

Third-party libraries (GTK, GtkSourceView, GStreamer, poppler, OpenSSL and the
rest) keep their own security policies. A bug in one of them is still worth
telling us about when Bintana's use of it is part of the path, but the fix may
belong upstream; the Windows bundle's versions are named in
`THIRD-PARTY-NOTICES.md`.

## What to expect

This is a small project: reports are read and answered on a best-effort basis,
without a guaranteed response time or a bounty. A fix is published in the next
release, and the advisory is credited unless you ask otherwise.
