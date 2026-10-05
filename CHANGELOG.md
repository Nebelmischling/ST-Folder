# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Das Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung an
[SemVer](https://semver.org/lang/de/).

Bewusst vor 1.0: die Extension ist im Alltag funktionsfähig und durch Tests abgesichert,
aber die Oberfläche hat noch Luft (siehe „Geplant").

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
