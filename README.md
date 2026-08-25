# Kompakt

Installierbare TypeScript-PWA zum lokalen Komprimieren von Video und Audio auf iOS. Medien werden ausschließlich nach Auswahl über den Systemdialog gelesen; die Ausgabe wird über das iOS-Teilen-Menü gesichert.

## Start

```bash
npm install
npm run dev
```

Produktionsprüfung: `npm run build`

Cloudflare-Veröffentlichung: `npm run deploy`. Der fest versionierte FFmpeg-WASM-Kern wird beim ersten Einsatz von jsDelivr geladen und anschließend vom Service Worker offline gespeichert; Nutzermedien verlassen das Gerät nicht.

## MVP

- Einzelauswahl aus Fotos oder Dateien
- automatische Medienanalyse mit FFprobe
- drei Kompressionsstufen
- H.264/AAC, M4A/AAC, MP3 und WAV als Ausgabe
- hardwarebeschleunigtes H.264 über WebCodecs/Mediabunny mit FFmpeg-WASM als Fallback
- stückweises Lesen und direkte OPFS-Ausgabe für Videos bis 1 GB
- 200-MB-Sicherheitslimit für Audio und den speicherintensiven Software-Fallback
- iOS-Teilen-Menü mit Download-Fallback
- HDR-Erkennung mit sicherer Ablehnung im MVP

Die Verarbeitung sollte auf iOS im Vordergrund bleiben. Große Dateien benötigen einen von WebCodecs unterstützten Videoeingang; Audio und der FFmpeg-Softwarepfad bleiben auf 200 MB begrenzt.
