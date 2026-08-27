// ==UserScript==
// @name         Torn Racing Segment Collector
// @namespace    local.torn-racing-dashboard
// @version      0.1.0
// @description  Captures Torn race segment intervals and driver segment times for export or upload.
// @match        https://www.torn.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      api.torn.com
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const storageKey = 'trsc_snapshots';
  const endpointKey = 'trsc_upload_endpoint';
  const tokenKey = 'trsc_upload_token';
  const defaultEndpoint = 'http://localhost:3000/api/browser/racing-segments';
  const maxSnapshots = 50;

  function installXhrCapture() {
    const XHR = pageWindow.XMLHttpRequest;

    if (!XHR?.prototype?.send || XHR.prototype.__trscInstalled) {
      return;
    }

    const nativeSend = XHR.prototype.send;
    Object.defineProperty(XHR.prototype, '__trscInstalled', { value: true });

    XHR.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        if (this.status !== 200 || typeof this.responseText !== 'string') {
          return;
        }

        captureResponseText(this.responseText);
      });

      return nativeSend.apply(this, args);
    };
  }

  function captureResponseText(responseText) {
    if (!responseText.includes('"raceData"') || !responseText.includes('"trackData"') || !responseText.includes('"cars"')) {
      return;
    }

    try {
      const data = JSON.parse(responseText);

      if (!isRaceSegmentPayload(data)) {
        return;
      }

      const snapshot = toSnapshot(data);
      const snapshots = getSnapshots();

      if (snapshots.some((existing) => existing.payloadHash === snapshot.payloadHash)) {
        return;
      }

      snapshots.unshift(snapshot);
      GM_setValue(storageKey, JSON.stringify(snapshots.slice(0, maxSnapshots)));
      updateButtonLabel();
      console.info('[Torn Racing Segment Collector] Captured race segment snapshot', {
        raceId: snapshot.raceId,
        trackName: snapshot.trackName,
        drivers: Object.keys(snapshot.raceData.cars).length,
        segments: snapshot.raceData.trackData.intervals.length,
      });
    } catch (error) {
      console.debug('[Torn Racing Segment Collector] Ignored unusable race response', error);
    }
  }

  function isRaceSegmentPayload(data) {
    return Boolean(
      data &&
        typeof data === 'object' &&
        data.raceID !== undefined &&
        data.raceData &&
        typeof data.raceData === 'object' &&
        data.raceData.trackData &&
        Array.isArray(data.raceData.trackData.intervals) &&
        data.raceData.cars &&
        typeof data.raceData.cars === 'object' &&
        Number.isInteger(Number(data.laps)) &&
        Number(data.laps) > 0,
    );
  }

  function toSnapshot(data) {
    const snapshot = {
      collectorVersion: '0.1.0',
      capturedAt: new Date().toISOString(),
      raceId: String(data.raceID),
      laps: Number(data.laps),
      trackName: normalizeTrackName(data.raceData?.title || ''),
      trackTornId: readTrackId(data),
      raceData: {
        title: data.raceData?.title || null,
        trackData: data.raceData?.trackData || null,
        cars: data.raceData?.cars || {},
        carInfo: data.raceData?.carInfo || {},
      },
      timeData: data.timeData || null,
      user: data.user || null,
    };

    snapshot.payloadHash = hashText(JSON.stringify(snapshot));
    return snapshot;
  }

  function readTrackId(data) {
    const candidates = [
      data.raceData?.trackData?.id,
      data.raceData?.trackData?.track_id,
      data.raceData?.trackID,
      data.raceData?.trackId,
      data.trackID,
      data.trackId,
    ];

    for (const candidate of candidates) {
      const parsed = Number(candidate);

      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  function normalizeTrackName(value) {
    return String(value || '')
      .split(/\s*-\s*(Race (started|finished|will Start|in progress)|Waiting|Cancelled|Starts:|lap|Lap|\d+\s+seconds?)/i)[0]
      .replace(/\s*-\s*\d+\s*laps?.*$/i, '')
      .trim();
  }

  function getSnapshots() {
    const raw = GM_getValue(storageKey, '[]');

    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function clearSnapshots() {
    GM_setValue(storageKey, '[]');
    updateButtonLabel();
  }

  function uploadLatestSnapshot() {
    const snapshot = getSnapshots()[0];

    if (!snapshot) {
      alert('No race segment snapshots captured yet.');
      return;
    }

    uploadSnapshot(snapshot);
  }

  function uploadAllSnapshots() {
    const snapshots = getSnapshots();

    if (snapshots.length === 0) {
      alert('No race segment snapshots captured yet.');
      return;
    }

    let index = 0;

    function next() {
      if (index >= snapshots.length) {
        alert('All snapshots uploaded.');
        return;
      }

      uploadSnapshot(snapshots[index], () => {
        index += 1;
        next();
      });
    }

    next();
  }

  function uploadSnapshot(snapshot, onDone) {
    const endpoint = String(GM_getValue(endpointKey, defaultEndpoint) || defaultEndpoint);
    const token = String(GM_getValue(tokenKey, '') || '').trim();
    const headers = {
      'content-type': 'application/json',
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: endpoint,
      headers,
      data: JSON.stringify(snapshot),
      timeout: 30000,
      onload: (response) => {
        if (response.status >= 200 && response.status < 300) {
          console.info('[Torn Racing Segment Collector] Upload succeeded', response.responseText);
          onDone?.();
          return;
        }

        alert(`Upload failed (${response.status}): ${response.responseText}`);
      },
      onerror: () => alert('Upload failed.'),
      ontimeout: () => alert('Upload timed out.'),
    });
  }

  function downloadJson() {
    downloadText('torn-racing-segments.json', JSON.stringify(getSnapshots(), null, 2), 'application/json');
  }

  function downloadCsv() {
    const rows = [['raceId', 'capturedAt', 'trackName', 'laps', 'driverName', 'driverId', 'carItemId', 'lapNumber', 'segmentIndex', 'segmentTime', 'lapTime']];

    for (const snapshot of getSnapshots()) {
      const segments = snapshot.raceData?.trackData?.intervals ?? [];
      const segmentCount = segments.length;
      const laps = Number(snapshot.laps) || 0;
      const cars = snapshot.raceData?.cars ?? {};
      const carInfo = snapshot.raceData?.carInfo ?? {};

      for (const [driverName, encoded] of Object.entries(cars)) {
        const intervals = decodeIntervals(encoded);
        const info = carInfo[driverName] || {};

        for (let lapIndex = 0; lapIndex < laps; lapIndex += 1) {
          const lap = intervals.slice(lapIndex * segmentCount, (lapIndex + 1) * segmentCount);
          const lapTime = round4(lap.reduce((sum, value) => sum + value, 0));

          lap.forEach((segmentTime, segmentIndex) => {
            rows.push([
              snapshot.raceId,
              snapshot.capturedAt,
              snapshot.trackName,
              snapshot.laps,
              driverName,
              info.userID || '',
              info.itemID || info.carID || '',
              lapIndex + 1,
              segmentIndex,
              segmentTime,
              lapTime,
            ]);
          });
        }
      }
    }

    downloadText('torn-racing-segments.csv', rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  }

  function decodeIntervals(encoded) {
    try {
      return atob(String(encoded || ''))
        .split(',')
        .map((value) => round4(Number(value.trim())))
        .filter((value) => Number.isFinite(value) && value >= 0);
    } catch {
      return [];
    }
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function downloadText(fileName, text, mimeType) {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function ensureControls() {
    const titleBar = document.querySelector('.drivers-list .title-black');

    if (!titleBar || document.getElementById('trscControls')) {
      return;
    }

    const controls = document.createElement('div');
    controls.id = 'trscControls';
    controls.innerHTML = `
      <button id="trscCollectBtn" type="button">Collect</button>
      <div id="trscMenu">
        <button id="trscUploadLatest" type="button">Upload latest</button>
        <button id="trscUploadAll" type="button">Upload all</button>
        <button id="trscJson" type="button">JSON</button>
        <button id="trscCsv" type="button">CSV</button>
        <button id="trscClear" type="button">Clear</button>
        <span id="trscStatus"></span>
      </div>
    `;
    const infoWrap = titleBar.querySelector('.track-info-wrap');

    if (infoWrap) {
      titleBar.insertBefore(controls, infoWrap);
    } else {
      titleBar.appendChild(controls);
    }

    document.getElementById('trscCollectBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      document.getElementById('trscMenu').classList.toggle('trscOpen');
      updateButtonLabel();
    });
    document.getElementById('trscUploadLatest').addEventListener('click', uploadLatestSnapshot);
    document.getElementById('trscUploadAll').addEventListener('click', uploadAllSnapshots);
    document.getElementById('trscJson').addEventListener('click', downloadJson);
    document.getElementById('trscCsv').addEventListener('click', downloadCsv);
    document.getElementById('trscClear').addEventListener('click', clearSnapshots);
    document.addEventListener('click', closeCollectMenu);
    updateButtonLabel();
  }

  function closeCollectMenu(event) {
    const controls = document.getElementById('trscControls');

    if (!controls || controls.contains(event.target)) {
      return;
    }

    document.getElementById('trscMenu')?.classList.remove('trscOpen');
  }

  function updateButtonLabel() {
    const status = document.getElementById('trscStatus');
    const button = document.getElementById('trscCollectBtn');
    const count = getSnapshots().length;

    if (status) {
      status.textContent = `${count} captured`;
    }

    if (button) {
      button.title = `${count} race segment snapshot${count === 1 ? '' : 's'} captured`;
    }
  }

  function hashText(text) {
    let hash = 0;

    for (let index = 0; index < text.length; index += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(index);
      hash |= 0;
    }

    return String(hash);
  }

  function round4(value) {
    return Math.round(value * 10000) / 10000;
  }

  GM_addStyle(`
    #trscControls {
      position: relative;
      float: right;
      z-index: 30;
      display: inline-flex;
      align-items: center;
      margin: 3px 29px 0 6px;
      font: 11px Arial, sans-serif;
    }
    #trscCollectBtn {
      border: 1px solid #1c8d45;
      border-radius: 3px;
      background: linear-gradient(#27b85f, #167d3c);
      color: #fff;
      font: inherit;
      font-weight: bold;
      line-height: 14px;
      padding: 2px 8px;
      cursor: pointer;
      text-shadow: 0 1px 0 rgba(0,0,0,.4);
    }
    #trscCollectBtn:hover {
      border-color: #52df82;
      background: linear-gradient(#32cc6e, #1c9147);
    }
    #trscMenu {
      position: absolute;
      top: 22px;
      right: 0;
      display: none;
      min-width: 122px;
      padding: 5px;
      border: 1px solid #444;
      border-radius: 4px;
      background: rgba(15,15,15,.96);
      box-shadow: 0 4px 10px rgba(0,0,0,.45);
    }
    #trscMenu.trscOpen {
      display: grid;
      gap: 4px;
    }
    #trscMenu button {
      border: 1px solid #555;
      border-radius: 3px;
      background: #222;
      color: #eee;
      font: inherit;
      padding: 4px 6px;
      text-align: left;
      cursor: pointer;
    }
    #trscMenu button:hover {
      border-color: #52df82;
    }
    #trscStatus {
      display: block;
      padding: 2px 3px 0;
      color: #bbb;
      white-space: nowrap;
    }
  `);

  installXhrCapture();

  function bootControls() {
    if (!document.body) {
      setTimeout(bootControls, 100);
      return;
    }

    ensureControls();
    setInterval(ensureControls, 1000);
  }

  bootControls();
})();
