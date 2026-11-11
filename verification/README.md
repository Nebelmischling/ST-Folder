# Verifikation der Extension "Character Folders"

Hier liegt die Testumgebung, mit der die Extension **ohne** `npm install` und **ohne**
laufenden SillyTavern-Server im echten Browser geprüft wird.

## Ausführen

```powershell
node verification/checks.mjs     # 60 Checks + Screenshots
```

Erwartete Ausgabe: `60/60 checks passed.` (Exit-Code 0). Bei einem Fehlschlag: Exit-Code 1
plus Liste der fehlgeschlagenen Checks. Screenshots landen in `verification/screenshots/`.

Zusätzlich liegen die Unit-Tests der reinen Logik im Repo-Root, direkt neben der Extension:

```powershell
node --test folder-store.test.js  # Unit-Tests der reinen Logik
```

## Wie das funktioniert

* `cdp.mjs` — abhängigkeitsfreier Browser-Treiber über das **Chrome DevTools Protocol**
  (nur `fetch`, globales `WebSocket`, `child_process`). Er nimmt das erste gefundene
  Chromium/Chrome/Edge (Playwright-Chromium, Chrome, Edge; überschreibbar per
  `CHROME_PATH`) und stellt eine kleine Playwright-ähnliche Fassade bereit. Maus- und
  Tastatureingaben laufen über `Input.dispatchMouseEvent`/`dispatchKeyEvent`, sind also
  echte, vertrauenswürdige Events — genau das braucht jQuery UI für Drag & Drop.
* `server.mjs` — Mini-Statikserver (127.0.0.1, Port 8124) mit diesen Routen:
  * `/scripts/extensions/third-party/character-folders/*` → **die echten Extension-Dateien**
    aus dem Repo-Root (der Ordnername in der URL ist beliebig)
  * `/lib/*`, `/css/*`, `/webfonts/*` → **echtes jQuery, jQuery UI, Touch-Punch, Font Awesome**
    (inkl. `solid.min.css`, weil dort die `@font-face`-Regeln liegen) aus einem
    SillyTavern-Checkout (gesucht via `ST_ROOT`, daneben/darüber, sonst Warnung)
  * `/script.js`, `/scripts/utils.js`, `/scripts/i18n.js` → Test-Doubles aus `stubs/`
* `harness.html` — bildet den DOM-Ausschnitt des Character-Management-Panels nach
  (`#rm_characters_block`, `#charListFixedTop`, `#rm_print_characters_block`), setzt
  `body.charListGrid` (Grid-Ansicht, wie auf dem Zielserver), hängt einen fremden
  „Browse"-Button ins Suchformular (wie NemoPresetExt ihn setzt) und stellt einen
  minimalen `SillyTavern.getContext()`-Stub bereit (inkl. `Popup`-Stub mit steuerbaren
  Rückgabewerten).
* `stubs/script.js` — implementiert die Verträge, die die Extension nutzt: `characters`,
  `entitiesFilter.filterFunctions` + `applyFilters()` (Reducer, genau wie
  `FilterHelper.applyFilters` in `public/scripts/filters.js`), `printCharacters*` und das
  Event `CHARACTER_PAGE_LOADED` am Ende jedes Listen-Renderings.

## Was geprüft wird

Panel-Injektion und -Position, Filter-Hook in der Filterkette, Zähler, Ordner anlegen
(top-level und als Unterordner über das echte Action-Menü), **Auswahl per Kästchen inkl.
Shift-Bereich und „All shown"**, **Bulk-Move per Ordnerklick**, **Undo** (und dass Wegklicken
den Move behält), „Unfiled"-Zeile als Verschiebe-Ziel, **Ordner-Dialog** („Move to…"),
Options-Toggles inkl. Abschaltbarkeit des Klick-Verschiebens, Drag & Drop von Charakterkarten
und Ordnern, **Zyklen-Schutz**, Drilldown-Filterung, Breadcrumb, Inline-Umbenennen per
Doppelklick, Löschen ohne Datenverlust, Komplett-Reset, **sofortiges Speichern bei
Inhaltsänderungen**, Toasts, leere Browser-Konsole, **Grid-Ansicht** (`charListGrid`),
Unversehrtheit eines fremden Buttons im Suchformular — und ein **Regressionstest** für den
Persistenzbug: SillyTavern initialisiert Extensions (`script.js:747`) **vor** der Charakterliste
(`script.js:759`); gespeicherte Zuordnungen müssen diesen Start mit leerer Liste überleben und
danach wieder greifen.

## Grenzen dieses Harness

Die ST-Kernmodule sind Doubles: geprüft wird die Extension (DOM, Baum, Drag & Drop, Filter-Hook,
Store-Anbindung), **nicht** das Verhalten von SillyTavern selbst. Die echten ST-Exporte, die die
Extension importiert, wurden zusätzlich statisch gegen `public/script.js`,
`public/scripts/utils.js` und `public/scripts/i18n.js` abgeglichen. Der echte Server wurde
separat geprüft (Extension-Discovery + HTTP-Auslieferung aller Dateien mit Status 200).

## Server-Werkzeuge

`../tools/` enthält die reinen Lese-Skripte, mit denen eine Zielinstallation untersucht wurde
(Systemd-Service, Datenlayout, vorhandene Extensions, Tag-/Ordnerlage, Git-Status, CPU/RAM/Platte,
Performance-Konfiguration). Sie schreiben nichts, brauchen kein `sudo` und geben keine Secrets aus.
