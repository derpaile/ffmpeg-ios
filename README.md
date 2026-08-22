# Kompakt

Installierbare TypeScript-PWA zum lokalen Komprimieren von Video und Audio auf iOS. Medien werden ausschließlich nach Auswahl über den Systemdialog gelesen; die Ausgabe wird über das iOS-Teilen-Menü gesichert.

## Start

```bash
npm install
npm run dev
```

Produktionsprüfung: `npm run build`

## MVP

- Einzelauswahl aus Fotos oder Dateien
- automatische Medienanalyse mit FFprobe
- drei Kompressionsstufen
- H.264/AAC, M4A/AAC, MP3 und WAV als Ausgabe
- FFmpeg-WASM vollständig in Workern, erst nach Dateiauswahl geladen
- Offline-Cache, 200-MB-Gerätelimit, OPFS-Zwischenspeicher
- iOS-Teilen-Menü mit Download-Fallback
- HDR-Erkennung mit sicherer Ablehnung im MVP

Die Verarbeitung sollte auf iOS im Vordergrund bleiben. Das Größenlimit ist als Konstante `MAX_FILE_SIZE` in `src/main.ts` hinterlegt und muss nach Gerätetests angepasst werden.
