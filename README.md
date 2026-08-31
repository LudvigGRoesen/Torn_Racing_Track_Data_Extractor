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

The script adds a green `Collect` button in the Torn race title bar to the left of the track info icon. The menu is rendered as a body-level popover so Torn containers do not clip it. The button menu supports:

- Upload latest JSON snapshot
- Upload all JSON snapshots
- Send JSON file payload directly to the upload endpoint
- Download JSON snapshots
- Download CSV rows
- Mark racers who are in the same faction as the current Torn API key owner
- Clear local snapshots

`Send JSON file` posts the same JSON array that `Download JSON snapshots` would save, but sends it directly to the configured endpoint instead of downloading it. The backend accepts one snapshot object, an array of snapshots, or `{ "snapshots": [...] }`.

## Faction markers

Use `Set Torn API key` in the userscript menu to store a Torn API key in the userscript manager. `Faction marks` fetches the current user's profile and the visible race participants' public profiles directly from Torn API v2, compares faction IDs in the browser, and adds a small faction shorthand badge next to matching racers.

Faction information is not uploaded to the app and is not stored in the database. Participant profile results are only cached in memory for a few minutes while the page is open.

This is intentionally separate from the main app for now. It can become a real browser extension later.
