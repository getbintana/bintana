# Flatpak: la aplicación empaquetada, y un runtime compartido

**Status: fases 0 a 5 hechas y la 6 preparada.** La fase 0 (el spike) dejó los
manifiestos en [`flatpak/`](../../flatpak/), que construyen y corren, y lo que
midió está abajo. La fase 1 le dio al proyecto su `id`: `Application.Id`, la
clase de ventana en los dos backends, y el IDE que lo pide al crear y lo edita
después. La fase 2 le dio a `Xml` los atributos con namespace (`xml:lang`), la
fase 3 el `<id>.metainfo.xml` como parte del proyecto con su editor, la fase 4
el generador (`lib/package` + `tools/pack`), y la fase 5 la división de los
manifiestos y `tools/flatpak-build.sh`. La fase 6 es el repo de pruebas: el
workflow está en [`flatpak/ci/`](../../flatpak/ci/README.md) y espera que el
repositorio se cree. Este plan es el diseño; lo que el runtime puede hacer está
en [`llm/`](../llm/README.md).

## What the application needed

Poder entregar una aplicación Bintana —y el propio IDE— como algo que se instala
y se actualiza con `flatpak`, sin depender de la distribución ni de Flathub. El
repositorio es **propio** y por una razón concreta: Flathub está rechazando
aplicaciones generadas por IA, así que la distribución no puede pasar por ahí.

De ahí salen dos cosas que este plan separa: **el runtime compartido** (un
BaseApp que una vez construido sirve a toda aplicación Bintana) y **la
herramienta que empaqueta** un proyecto, porque quien escribe una aplicación no
debería tener que escribir a mano un manifiesto, un `.desktop` ni un
`metainfo.xml`.

## What the spike measured

Todo esto está medido en esta máquina (GNOME 50, GTK 4.22.4, flatpak 1.18.2):

- **El layout instalado ya es el layout Flatpak.** El runtime resuelve
  `share/bintana/{lib,ide}`, la referencia y los ejemplos por saltos relativos a
  su propio binario, así que `/app/bin/bintana` encuentra `/app/share/...` con
  **cero cambios en el C**.
- **Construir**: BaseApp 43 s (QuickJS + runtime completos), IDE 2 s, ejemplo 2 s.
- **El SDK de GNOME trae** GTK 4.22.4, GtkSourceView 5, sqlite 3.50.4, libsoup
  3.6.6, GStreamer 1.26.11 **con `libgstgtk4.so`** (el sink de `Video`),
  gtk4-unix-print, libxml2 2.14.6 y libsystemd 261. **No trae VTE** (por eso
  `Widget.Available("Terminal")` es `false`: 46 de 47 tipos), ni git, ni
  compilador.
- **El journal funciona dentro del sandbox** (`Logger.Target = "Journal"` llegó
  al journal del host).
- **El BaseApp es dependencia de build, no de runtime**: se desinstaló y el IDE
  siguió corriendo; los archivos se copian en el commit de cada app y el disco
  los deduplica. El IDE son **2,5 KB** de contenido nuevo sobre el BaseApp.
- **Consecuencia de eso**: actualizar el BaseApp **no** actualiza las apps; hay
  que reconstruirlas y republicarlas.
- **Un repo estático alcanza**: servido con `python3 -m http.server`, `remote-add`
  + `install` + correr, sin ninguna herramienta extra.
- **flatpak 1.18.2 tiene el bug [#6818](https://github.com/flatpak/flatpak/issues/6818)**
  (`build-init --base` falla con `lsetxattr(security.selinux)`), arreglado en
  1.18.3. No es SELinux: falla igual en Permissive. El CI (Ubuntu 24.04, flatpak
  1.14) no lo sufre.

## Decisiones

- **`project.json` declara `id`** (reverse-DNS). El runtime lo valida con
  `g_application_id_is_valid` y rechaza el proyecto con una frase si no lo es.
- **`Application.Id` se publica** y se usa como `application_id` de
  `GtkApplication`; además `g_set_prgname(id)`, porque X11 arma `WM_CLASS` con
  el nombre del programa y no mira el application_id (Wayland sí:
  `gdktoplevel-wayland.c`). Con eso `StartupWMClass` es el id en los dos.
- **`<id>.metainfo.xml` es editable**, con `<id>` y `<name>` validados contra
  `project.json`.
- **El generador es `lib/package` + `tools/pack`**, no un verbo del runtime.
- **Los ids son `io.github.getbintana.*`** hasta la publicación oficial; el
  repo comunitario (`flatpak.getbintana.org`) puede cambiarlos antes.
- **El BaseApp no lleva el IDE ni los ejemplos.** Si los llevara, cualquier
  cambio en `ide/` cambiaría el BaseApp y obligaría a reconstruir todo; con la
  división, un cambio en una app reconstruye esa app.

## Fase 1 — Identidad

`project.json` gana `id`. El runtime lo lee en `bta_app_new`, lo valida y lo
publica como `Application.Id`; en `bta_app_run` crea la `GtkApplication` con ese
id (y sin id, como hoy). El IDE lo pide al crear un proyecto, lo edita en
`ProjectForm` y lo usa para la entrada de menú de `Apps.js`. Los `.desktop` del
IDE pasan a `StartupWMClass=io.github.getbintana.Ide` y el comentario del
`exec -a` de `tools/bintana-ide.in` se actualiza: con id, la clase la fija el
runtime. `ide/project.json` y `examples/hello/project.json` declaran el suyo.

## Fase 2 — Atributos con namespace en `Xml`

`Xml.SetAttrNS(uri, name, value)`, `AttrNS(uri, name)` y `RemoveAttrNS`. Hoy
`SetAttr` rechaza `:` a propósito y `xml:lang` es inexpresable, que es
exactamente lo que AppStream necesita para traducir. Es C en `bta_xml.c` y el
resto del DOM no cambia.

## Fase 3 — El metainfo como parte del proyecto

`<id>.metainfo.xml` en la raíz del proyecto. El IDE lo abre como texto con
resaltado (`EDITABLE.xml`) y con un formulario estructurado (`MetainfoForm`,
patrón `PoForm`): lee con `File.LoadXml`, edita los campos comunes —id, nombre,
resumen, descripción con idiomas, developer, licencias, URLs, categorías,
releases, launchable— y guarda con `File.SaveXml`, **preservando lo que no
edita** (el DOM conserva elementos y atributos desconocidos). Valida que el
`<id>` y el `<name>` sin idioma coincidan con `project.json`.

## Fase 4 — El generador

`Desktop.Entries.Write(path, entry)` en el runtime —el verbo por ruta que le
falta al módulo, reusando el cuerpo de `Install`— y `lib/package` con una clase
`Package` que, para un proyecto, escribe:

- el metainfo validado,
- `<id>.desktop` con `Desktop.Entries.Write` (`Exec`, `Icon`, `StartupWMClass`),
- el manifiesto Flatpak **en JSON** (flatpak-builder lo acepta: no hace falta
  escritor de YAML),
- el ícono, por convención `icons/<id>.svg`.

`tools/pack` es un proyecto consola (sin display) con su `.sh`, para el CI y
para la mano. Validan `appstreamcli validate` y `desktop-file-validate`.

## Fase 5 — Construir

`tools/flatpak-build.sh` construye el BaseApp y las apps, corre
`flatpak build-update-repo --generate-static-deltas` y deja el repo staged. Los
manifiestos se dividen como dicen las decisiones: el BaseApp se queda con el
runtime y las librerías; el IDE y cada ejemplo llevan lo suyo. Un `Dockerfile`
opcional para construir localmente sin ensuciar el host (bwrap necesita
`--privileged` o `/dev/fuse`).

## Fase 6 — El repo de pruebas y su CI

Un repo nuevo (`getbintana/flatpak`) con el workflow y una rama `gh-pages` con
el repo publicado; los manifiestos quedan en el principal para no duplicarlos.
El CI construye BaseApp, IDE y un ejemplo, publica con `--generate-static-deltas`
(sin firma para las pruebas) y corre el smoke que ya se midió:
`flatpak run --command=bintana <app> --version` más un proyecto consola.

**La incrementalidad se registra, no se adivina.** Un `builds.json` en el repo
publicado guarda por ref el commit construido y los prefijos que lo componen; en
cada corrida el CI compara contra el ref objetivo:

| cambió | se reconstruye |
|---|---|
| `runtime/**`, `vendor/**`, `lib/**`, `CMakeLists.txt` | el BaseApp **y todas las apps** |
| `ide/**`, `docs/**` | solo el IDE |
| `examples/hello/**` | solo el ejemplo |
| un tag nuevo en el principal | todo, y queda registrado |

El disparo arranca con `workflow_dispatch` + `schedule` (sin secretos) y pasa a
`repository_dispatch` desde el workflow de tag cuando el repo principal sea
público, que es lo que el disparo inmediato necesita. El SDK se cachea
(`actions/cache` sobre `~/.local/share/flatpak`): son 837 MB por corrida.

## What is deliberately not here

- **VTE en el BaseApp.** El IDE no la necesita (su panel de salida es un
  `TextEditor`); `Terminal` queda como una capacidad que una app compila si la
  quiere. Si el repo comunitario la ofrece, es un módulo del BaseApp y una
  decisión de esa fase.
- **git dentro del sandbox del IDE.** No está en el runtime; las salidas son
  empaquetarlo, `flatpak-spawn --host` con `--talk-name=org.freedesktop.Flatpak`,
  o decir que no está. Es una decisión del IDE, no del empaquetado.
- **`Desktop.Entries` dentro del sandbox**, que escribe en un `XDG_DATA_HOME`
  privado y no llega al menú del host. Un Exec de `flatpak run <id>` es el
  arreglo probable y toca al runtime.
- **El repo comunitario.** Este plan deja las herramientas; `flatpak.getbintana.org`
  es una decisión de infraestructura posterior.

## Tests

- `tests/widgets`: `Application.Id` y el rechazo de un id inválido; los verbos
  NS de `Xml`; `Desktop.Entries.Write`.
- `tests/ide`: el alta de un proyecto pide id; `ProjectForm` lo edita; `Apps`
  lo usa; el editor de metainfo abre, valida y guarda.
- `tests/api.sh` y `tests/typings.sh` al día en cada fase, como manda la regla.
- El CI del repo de pruebas corre el smoke de Flatpak; `tests/install.sh` sigue
  siendo el del install común.

## Docs, in the same change

`docs/formats.md` y `llm/forms.md` para `id`; `reference/globals/Application.md`
y `runtime-api.md` para `Application.Id`; `reference/globals/Xml.md` y
`llm/library.md` para los atributos con namespace; `reference/globals/Desktop.md`
y `llm/library.md` para `Write`; `docs/llm/package.md` para la librería nueva
(lo exige `tests/api.sh`); `ide.md` para el editor de metainfo; `installing.md`
para el Flatpak; `testing.md` para los conteos.
