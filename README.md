# FotoVibe

Private Party-Fotogalerie für etwa 100 Gäste. Deutschsprachige Oberfläche,
gemeinsamer Party-Code, native Handykamera und explizite Upload-Bestätigung.

## Infrastruktur

- Projekt: `project-8b626ca4-30b1-415b-84b`
- Cloud Run: `europe-west1` (Belgien), `fotovibe`, 1 vCPU / 1 GiB,
  0–2 Instanzen, Concurrency 4
- Foto-Bucket: `gs://fotovibe-520703150508-photos`
- Secret: `fotovibe-auth` (Code und Sitzungsschlüssel; Replikation Frankfurt)
- Laufzeitidentität: `fotovibe-runtime`, Objekt-Erstellung/-Lesen nur im Foto-Bucket
  und Zugriff nur auf das Auth-Secret. Keine Löschrechte, keine Schlüsseldateien.
- Build-Identität: `fotovibe-build`, dokumentierte Rolle `roles/run.builder`.
- Cloud Build und Artifact Registry werden nur für Builds/Image-Ablage benötigt.
  Quellarchive ab sieben Tagen werden entfernt; in Artifact Registry bleiben
  mindestens die drei jüngsten Container-Versionen erhalten.

Foto-Bucket und Secret liegen in Frankfurt (`europe-west3`). Der Dienst verarbeitet
die Bilder in Belgien, weil direkte Cloud-Run-Domain-Mappings in Frankfurt nicht
angeboten werden. Das ist keine Zusage, dass sämtliche GCP-Kontroll-, Support- oder
Abrechnungsdaten ausschließlich in diesen Regionen verarbeitet werden.

## Lokal starten

Benötigt: Python 3.12, uv, Node.js 24+ und npm. Node wird ausschließlich zum
Einbinden des HEIC-Decoders benötigt, nicht zur Laufzeit des Servers.

```sh
env -u UV_DEFAULT_INDEX uv sync --frozen
npm ci --ignore-scripts
npm run build
make run
```

Öffne `http://127.0.0.1:8080`. Der **ausschließlich lokale** Test-Code ist
`1234` (auch mit Leerzeichen als `1 2 3 4` akzeptiert). Lokale Fotos liegen unter `.local/photos`. Der Entwicklungsmodus
verwendet keine GCP-Ressourcen und ungesicherte lokale Cookies; niemals öffentlich
bereitstellen. Der produktive Container startet ohne Auth-Secret nicht.

`make run` beendet vor dem Start einen bereits laufenden Prozess auf `PORT`
(standardmäßig `8080`) und aktiviert danach den Entwicklungsserver mit Hot Reload.
Für einen anderen Port: `make run PORT=8081`. Beenden mit `Ctrl-C`.

Der Entwicklungsserver beobachtet Python, HTML, CSS, JavaScript und SVG. Nach
einer Änderung startet er das lokale Backend neu; eine bereits geöffnete Seite
lädt sich automatisch neu. Der direkte Aufruf bleibt ebenfalls möglich:
`env -u UV_DEFAULT_INDEX uv run --frozen python scripts/dev.py --port 8081`.

## Deployment und erneutes Deployment

```sh
make deploy
```

Das Skript aktiviert die APIs, erstellt fehlende Ressourcen und deployt aus dem
Quellcode. Anschließend richtet es die Cloud-Run-Mappings und Cloud-DNS-Einträge
für `180-foto.com` und `www.180-foto.com` ein. Beim ersten Lauf kann die Ausstellung
der Google-verwalteten HTTPS-Zertifikate nach dem Deployment noch einige Zeit dauern.
Bestehende Fotos und der Party-Code bleiben erhalten. Alle
projektbezogenen CLI-Aufrufe verwenden explizit das obige Projekt und ändern
keine globale gcloud-Konfiguration. Bei neuen IAM-Zuweisungen kann ein erster
Build wegen verzögerter Berechtigungsübernahme fehlschlagen; nach einigen Minuten
denselben Befehl wiederholen. Keine zusätzlichen pauschalen Editor-Rechte vergeben.

Der Build verwendet das Dockerfile und die Lockfiles. `.gcloudignore` und
`.dockerignore` schließen lokale Daten, Testbilder und Secrets aus.
Die erzeugte URL steht nach Erfolg in `.local/deployment.json`.

```sh
gcloud run services describe fotovibe \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1 \
  --format='value(status.url)'
```

Upload: `https://180-foto.com`, Galerie: `https://180-foto.com/gallery`.
Für die Kamera auf dem Handy die HTTPS-Adresse in Safari bzw. Chrome öffnen,
möglichst nicht im integrierten Browser einer Messenger-App.

„Foto aufnehmen“ fordert über die Browser-Kamera-API Zugriff auf eine Kamera an
und zeigt eine Live-Vorschau mit Auslöser. Das funktioniert auch in Desktop-
Browsern mit Webcam. Falls ein Browser die API nicht unterstützt oder der Zugriff
nicht möglich ist, bietet die Oberfläche zusätzlich den nativen Kamera-/Datei-
Dialog an. Kamerazugriff funktioniert außerhalb von `localhost` nur über HTTPS.

## Party-Code anzeigen oder wechseln

Code der zuletzt erstellten Secret-Version anzeigen (nicht öffentlich teilen):

```sh
gcloud secrets versions access latest --secret=fotovibe-auth \
  --project=project-8b626ca4-30b1-415b-84b | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["party_code"])'
```

Das Deployment bindet eine konkrete Secret-Version. Eine manuell hinzugefügte
Version wird erst mit einem erneuten Deployment aktiv. Nach einem gescheiterten
Code-Wechsel kann `latest` bereits den neuen, noch nicht aktiven Code enthalten.
Die aktive Version steht in der Cloud-Run-Konfiguration und nach erfolgreichem
Deployment in `.local/deployment.json`.

```sh
make deploy-rotate-code
```

Erzeugt einen neuen zehnstelligen Code samt Sitzungsschlüssel und deployt ihn.
Damit müssen sich alle Gäste erneut anmelden. Fotos bleiben erhalten.
Eine private lokale Kopie neu erzeugter Secrets liegt in `.local/auth.json`
(Dateirechte `0600`, nicht für Git/Build vorgesehen).

## Fotos und Datenschutz

- JPEG, PNG, WebP, HEIC/HEIF, maximal 25 MiB und 64 Millionen Pixel je Datei.
- Ein Foto pro Upload. Keine Videos, RAW-Dateien oder animierten PNG/WebP.
- Die App speichert genau die Datei, die der Browser übergibt. Das Betriebssystem
  kann bereits vor der Übergabe Formate umwandeln oder die Aufnahme begrenzen.
- Originale werden nicht verändert. Anzeigeversion (max. 2560 px) und Thumbnail
  (max. 640 px) sind JPEGs mit korrigierter Orientierung und ohne EXIF/GPS.
- Originale können EXIF/GPS enthalten und sind für alle mit Party-Code downloadbar.
- Kein Upload vor Bestätigung. HEIC-Vorschauen werden lokal im Browser berechnet;
  der mitgelieferte Decoder wird nur bei Bedarf nachgeladen, ohne externes CDN.
- Keine automatische Fotolöschung, kein Versionsarchiv. Nach manueller Löschung
  bewahrt GCS die Daten durch Soft Delete noch sieben Tage auf.
- Keine Analyse-/Tracking-Software. GCP führt betriebliche Request-/Fehlerlogs;
  die Anwendung protokolliert keine Codes, Sitzungswerte, Bildinhalte oder EXIF.
- Der Party-Code ist ein gemeinsamer Zugang, keine persönliche Identifizierung.
  Wer ihn erhält, kann ihn weitergeben. Ersetze ihn nach Bedarf.

## Speicherlayout und Upload-Wiederholung

```text
photos/<UUID>/original
photos/<UUID>/display.jpg
photos/<UUID>/thumb.jpg
published/<UUID>.json
```

Die Originaldatei hat einen SHA-256-Wert als Objektmetadatum. Alle Schreibvorgänge
verwenden eine GCS-Generation-Vorbedingung (`ifGenerationMatch=0`). Ein bereits
verwendeter Upload-Schlüssel mit anderem Bildinhalt wird abgewiesen.
Der abschließende `published`-Datensatz macht das Foto erst nach erfolgreicher
Speicherung aller drei Dateien sichtbar. Wiederholungen nach einem Abbruch
ergänzen fehlende Objekte und erstellen keinen zweiten Galerieeintrag.

Abgebrochene, nie wiederholte Uploads können unveröffentlichte Objekte unter
`photos/` hinterlassen. Sie sind über die App nicht abrufbar, verursachen aber
Speicherkosten. Sie werden bewusst nicht automatisch gelöscht. Bei einer
späteren Bereinigung zuerst mit den IDs unter `published/` vergleichen.

## Originale exportieren

```sh
mkdir -p export
gcloud storage rsync --recursive \
  gs://fotovibe-520703150508-photos export \
  --project=project-8b626ca4-30b1-415b-84b
```

Dies sichert Originale, Vorschauen und Metadaten. Das Originalformat steht in
`published/<UUID>.json` als `extension`; die Originaldatei heißt im Bucket bewusst
`original`. Zum Öffnen eine Kopie mit der entsprechenden Endung erstellen.

## Einzelne Fotos löschen

Nur als Gastgeber über gcloud, nach Sicherung. Zuerst den Veröffentlichungsdatensatz
löschen, dann die zugehörigen Dateien. `FOTO_UUID` durch eine tatsächliche ID ersetzen.

```sh
gcloud storage rm gs://fotovibe-520703150508-photos/published/FOTO_UUID.json \
  --project=project-8b626ca4-30b1-415b-84b
gcloud storage rm 'gs://fotovibe-520703150508-photos/photos/FOTO_UUID/**' \
  --project=project-8b626ca4-30b1-415b-84b
```

Galerielisten werden maximal fünf Sekunden serverseitig zwischengespeichert.
Bereits geöffnete Galerien können ein gelöschtes Vorschaubild bis zum Neuladen
zeigen; der geschützte Bildabruf verweigert Zugriff ohne Veröffentlichungsdatensatz.
Bereits heruntergeladene Originale lassen sich nicht zurückrufen.

## Betrieb, Kosten und Abschalten

Cloud Run verwendet anfragebasierte Abrechnung mit `min=0`. Eine geöffnete,
sichtbare Galerie fragt alle 15 Sekunden nach neuen Bildern; in einem versteckten
Tab pausiert sie. Erst ohne Anfragen kann Cloud Run auf null skalieren.
Cold Starts sind akzeptiert. 1 GiB ermöglicht die Bearbeitung großer Handyfotos,
wobei pro Instanz nur eine Konvertierung gleichzeitig läuft.

Es gibt keine garantierte Nullrechnung: Foto-/Image-/Quellcode-Speicherung,
Operationen, Builds und Internet-Downloads können kostenpflichtig bleiben.
Das Maximum von zwei Instanzen ist **kein hartes Budgetlimit**. Es können zudem
vorübergehende Überhänge bei Deployments/Plattformwartung auftreten.
Rate-Limits sind pro Instanz und im Speicher (30 fehlgeschlagene Anmeldungen je
IP/Minute; 10 Upload-Versuche je Sitzung/Minute), keine globale Missbrauchsquote.

```sh
gcloud run services logs read fotovibe --limit=30 \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1
```

Zum Stilllegen der Website ohne Fotolöschung:

```sh
gcloud run services delete fotovibe \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1
```

Der Foto-Bucket bleibt dabei erhalten. Für vollständigen Rückbau erst exportieren
und den Export prüfen; anschließend die Fotoobjekte und den Bucket, die
Artifact-Registry-Images/das Repository `cloud-run-source-deploy`, den Source-Bucket
`run-sources-project-8b626ca4-30b1-415b-84b-europe-west1`, das Secret sowie die beiden
Service Accounts gezielt entfernen. Keine fremden Projektressourcen löschen.
Es gibt absichtlich keinen automatisch ausgeführten destruktiven Rückbau.

## Tests

```sh
env -u UV_DEFAULT_INDEX uv run --frozen pytest -q
env -u UV_DEFAULT_INDEX uv run --frozen ruff check fotovibe tests scripts
node --check static/app.js
```

Der Live-Smoke-Test erstellt ausschließlich synthetische Testbilder und räumt
seine eigenen UUIDs im `finally`-Block wieder auf:

```sh
make smoke
```

Vor der Feier auf **echtem iPhone/Safari und Android/Chrome** prüfen:

1. Party-Code eingeben, Kamera starten, Zugriff erlauben oder abbrechen.
2. Hoch- und Querformat aufnehmen, verwerfen, erneut aufnehmen, bestätigen.
3. JPEG und vorhandenes HEIC aus der Bibliothek auswählen; Vorschau abwarten.
4. Upload, Erfolg, Galerie auf zweitem Gerät und Original-Download prüfen.
5. Schlechtes Netz/Verbindungsabbruch testen: Fehlermeldung, Wiederholung, kein Duplikat.
6. In Messenger-internen Browsern bei Problemen in Safari/Chrome wechseln.

Browsergrößen-Simulation ersetzt diese Geräteprüfung nicht.
