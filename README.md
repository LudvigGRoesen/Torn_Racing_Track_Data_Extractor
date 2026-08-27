# Torn Racing Segment Collector

Userscript proof-of-concept for collecting Torn browser race segment data.

## What it captures

The script hooks Torn's browser `XMLHttpRequest` responses and stores race snapshots when the response contains:

- `raceID`
- `laps`
- `raceData.trackData.intervals`
- `raceData.cars`
- `raceData.carInfo`

`raceData.cars` values are base64-encoded comma-separated segment times. The upload endpoint decodes them and stores per-driver, per-lap, per-segment samples.

## Local upload endpoint

Default endpoint:

```text
http://localhost:3000/api/browser/racing-segments
```

If `BROWSER_RACING_COLLECTOR_TOKEN` is set in the app `.env`, configure the same token in the userscript storage and it will be sent as:

```http
Authorization: Bearer <token>
```

## UI and export formats

The script adds a green `Collect` button in the Torn race title bar next to the track info icon. The button menu supports:

- Upload latest JSON snapshot
- Upload all JSON snapshots
- Download JSON snapshots
- Download CSV rows
- Clear local snapshots

This is intentionally separate from the main app for now. It can become a real browser extension later.
