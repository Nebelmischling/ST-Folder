# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Das Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung an
[SemVer](https://semver.org/lang/de/).

Bewusst vor 1.0: die Extension ist im Alltag funktionsfähig und durch Tests abgesichert,
aber die Oberfläche hat noch Luft (siehe „Geplant").

## [Unveröffentlicht]

### Geändert

- **Das Repo-Root ist jetzt die Extension:** `manifest.json`, `index.js`, `style.css` und
  `folder-store.js` liegen im Wurzelverzeichnis. SillyTavern klont beim Installieren das ganze
  Repo nach `data/<handle>/extensions/ST-Folder/` und sucht die Manifest direkt dort — vorher
  brach die Installation über die GitHub-URL mit „Manifest file not found" ab.
- `install-character-folders.ps1` kopiert nur noch die vier Extension-Dateien statt des ganzen
  Repo-Roots (kein `tools/`, kein `verification/`, kein lokaler SillyTavern-Checkout).
- Der Browser-Harness serviert die Extension-Dateien aus dem Repo-Root.

### Entfernt

- Screenshots, die nirgends verwendet wurden (`grid-mode-full`, `list-mode-full`,
  `panel-grid-mode`, `panel-selection`) — der Harness schreibt nur noch die beiden Bilder,
  die das README zeigt.
- Einmal-Analyseskripte `deepdive3`–`deepdive6-server.sh` und `perf-check2-server.sh`; deren
  Erkenntnisse sind in Extension, README und diesem Changelog eingeflossen.

## [0.5.1] – 2026-11-09

Fehlerbehebungen aus einem unabhängigen Code-Review, plus zwei Render-Optimierungen.
Keine Änderungen am Ordner-Modell und am Settings-Format.

### Behoben

- **Duplizieren verschiebt nicht mehr die Zuordnung:** ein Duplikat erbt den Ordner,
  das Original behält ihn. Vorher fiel das Original still auf „Unfiled" und der Zähler
  blieb falsch. Neue reine Funktion `copyCharacterAssignment()` samt Test.
- **Ordnernamen im Popup werden HTML-escaped** (Unterordner-Nachfrage und
  Lösch-Bestätigung). Vorher konnte ein Name aus einem importierten Backup Markup in die
  Popup-Baumstruktur schmuggeln.
- **„Delete" im Ordner-Menü erscheint wieder rot:** `classes` erwartet ein Array,
  ein String wurde von SillyTavern in Einzelbuchstaben zerlegt.
- **Undo meldet keinen Erfolg mehr, wenn nichts mehr rückgängig zu machen ist**
  (z. B. nach Reset oder Import); die Auswahl- und Undo-Zustände werden dort jetzt
  zurückgesetzt.
- **Doppelter Baum-Aufbau entfernt:** `CHARACTER_PAGE_LOADED` (Suche, Blättern,
  Sortieren) baut den Ordnerbaum nicht mehr neu, sondern aktualisiert nur noch die
  Karten-Kästchen und den „Unfiled"-Zähler.
- **Auswahl-Klicks rendern nur noch Leiste, Zeilenklasse und Badge** statt des ganzen
  Baums inklusive aller jQuery-UI-Widgets.

### Geändert

- Eine gemeinsame Farbnormalisierung (`normalizeColor`) für Baum und Farbwähler;
  `MAX_NAME_LENGTH` wird jetzt auch für das Umbenennen-Feld genutzt statt der Zahl 60.
- Doku-Kommentare nennen den tatsächlichen Settings-Key `character-folders`.

## [0.5.0] – 2026-11-09

Erste veröffentlichte Fassung.

### Hinzugefügt

- Verschachtelter Ordnerbaum im Character Management — genau ein Ordner pro Charakter.
- Auswahl-Workflow: Kästchen auf der Karte, **Shift-Klick** für Bereiche, **All shown**,
  Verschieben per Klick auf den Zielordner, **Undo**, **Move to…**-Dialog und die
  **Unfiled**-Zeile als Ziel.
- Drag & Drop von Charakteren und Ordnern (mit Autoscroll; eine Auswahl wandert gemeinsam).
- Drilldown mit Breadcrumb; Ordner anlegen, umbenennen (Doppelklick), färben, sortieren
  und löschen ohne Datenverlust; Schutz vor Zyklen.
- Export/Import der Struktur als JSON, „Create folders from tags", Aufräumen verwaister
  Zuordnungen (mit Anzahl im Options-Menü).
- 25 Unit-Tests der reinen Logik und 60 Browser-Checks über das DevTools-Protokoll
  (ohne `npm install`).

### Behoben

- **Datenverlust beim Seitenaufbau:** SillyTavern initialisiert Extensions
  (`script.js:747`) vor der Charakterliste (`script.js:759`). Das automatische Aufräumen
  deutete die leere Liste als „alle Charaktere gelöscht" und entfernte sämtliche
  Zuordnungen. Aufräumen ist jetzt optional (nur auf Klick, mit Anzahl) und verweigert sich
  bei leerer Charakterliste.
- Inhaltsänderungen schreiben sofort in die `settings.json` statt entprellt — ein direktes
  Neuladen kann nichts mehr verlieren.
- Doppelklick-Zum-Benennen war unmöglich, weil schon der erste Klick den Baum neu aufbaute.
- Eingeklappte Ordner versteckten ihre Unterordner nicht.
- Drag & Drop kam nie an: jQuery UI übergibt bei eigenem Helper den **geklonten** Helper an
  `accept`/`drop`, Klone tragen keine jQuery-`data`. Der Payload liegt jetzt in
  HTML-Attributen.
- Autoscroll beim Ziehen war abgeschaltet — bei langen Listen war das Ordnerpanel nicht
  erreichbar.

### Geplant

- Suche/Filter im Ordnerbaum (sinnvoll ab etwa 20 Ordnern).
- Freie Sortierung innerhalb eines Ordners per Drag, statt nur **Move up/down**.
- Tastaturbedienung: Fokus im Baum, Enter = öffnen, Leertaste = markieren.
- Migration der Ordner aus NemoPresetExt (`localStorage`) als Ein-Klick-Import.
- Angezeigte Version im Panel (Support-Frage „welche Fassung läuft?").
- Ordner-Farben auch auf die Karten im Listenkopf anwenden (optional).
