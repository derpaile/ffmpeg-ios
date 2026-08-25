# Kompakt

Installierbare TypeScript-PWA zum lokalen Komprimieren von Video und Audio auf iOS. Medien werden ausschließlich nach Auswahl über den Systemdialog gelesen; die Ausgabe wird über das iOS-Teilen-Menü gesichert.

## Start

```bash
npm install
npm run dev
```

Produktionsprüfung: `npm run build`

Cloudflare-Veröffentlichung: `npm run deploy`. Alle benötigten Komponenten werden mit der App ausgeliefert; Nutzermedien verlassen das Gerät nicht.

## MVP

- Einzelauswahl aus Fotos oder Dateien
- automatische Medienanalyse mit Mediabunny
- drei Kompressionsstufen
- H.264/AAC, M4A/AAC, MP3, WAV und FLAC als Ausgabe
- hardwarebeschleunigtes H.264 über WebCodecs/Mediabunny
- bedarfsgeladene AAC-, MP3- und FLAC-Encoder
- stückweises Lesen und direkte OPFS-Ausgabe ohne feste Dateigrößengrenze
- iOS-Teilen-Menü mit Download-Fallback
- HDR-Erkennung mit sicherer Ablehnung im MVP

Die Verarbeitung sollte auf iOS im Vordergrund bleiben. Die praktische Grenze bestimmen freier Gerätespeicher und die vom Browser unterstützten Eingabecodecs. Komprimierte Audioeingaben benötigen auf dem iPhone iOS 26 oder neuer; WAV wird direkt gelesen.
