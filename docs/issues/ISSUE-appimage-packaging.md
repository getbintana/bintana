# ISSUE: no AppImage, no deb or rpm, no signing, no updates

## What the application needed

A way to hand the application to a person who is not on the distribution's
package manager: one file they download, double-click, and have the program
start — and be told when a newer one exists. The concrete case was a customer
on a machine their IT department does not manage.

## What I wrote instead

A tarball and a README. Flatpak is the real answer and it exists: `lib/package`
and `tools/pack.sh` write the manifest, and the flatpak plan's phases 0 to 5 are
done with phase 6 built and waiting for its trigger (docs/plans/flatpak-plan.md).
But a person without Flathub, or on a machine where flatpak is not installed,
still gets a tarball to unpack — on Windows there is an NSIS installer.

## The code I wish I could have written

```js
// the same call, another format -- `Package.Write` is the packaging step:
Package.Write(project, out, { Format: "AppImage" })
Package.Write(project, out, { Format: "Deb" })
Package.Sign(out, key)                   // and what makes it installable
```

## Why the existing words do not cover it

`Package.Write` writes the Flatpak build context — the metainfo, the desktop
entry, the icon, a copy of the project and the manifest — and there is no
format behind it: the manifest it writes is what `flatpak-builder` reads, and
nothing produces a single self-contained file or signs it.

## Prior art

AppImage, the single-file format this is named after. `deb` through `dpkg` and
`rpm` through `rpm`. Flatpak, which exists here. Snap. MSIX on Windows.
Electron's `electron-builder` writes all of them from one configuration.

## How much it mattered

It works, but a part of it is noticeably worse: handing one file to a person
who is not on the distribution's package manager is a tarball and a README,
and the audit's own list of what a newcomer needs — "dated releases, a
changelog, Flathub, complete examples, a forum" (docs/audit-2026-10.md §5) —
is answered by none of it.
