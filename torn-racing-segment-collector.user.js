// ==UserScript==
// @name         Torn Racing Segment Collector
// @namespace    local.torn-racing-dashboard
// @version      0.1.1
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
  const tornApiKey = 'trsc_torn_api_key';
  const factionMarkersEnabledKey = 'trsc_faction_markers_enabled';
  const defaultEndpoint = 'http://localhost:3000/api/browser/racing-segments';
  const tornApiBaseUrl = 'https://api.torn.com/v2';
  const maxSnapshots = 50;
  const profileCacheTtlMs = 5 * 60 * 1000;
  const factionMarkerState = {
    loading: false,
    lastRunAt: 0,
    ownProfile: null,
    profileCache: new Map(),
  };

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

  function sendJsonFile() {
    const snapshots = getSnapshots();

    if (snapshots.length === 0) {
      alert('No race segment snapshots captured yet.');
      return;
    }

    uploadPayload(snapshots, (result) => {
      const created = result?.created ?? 0;
      const duplicates = result?.duplicates ?? 0;
      alert(`JSON file sent. Created ${created}, duplicates ${duplicates}.`);
    });
  }

  function uploadSnapshot(snapshot, onDone) {
    uploadPayload(snapshot, () => {
      onDone?.();
    });
  }

  function uploadPayload(payload, onDone) {
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
      data: JSON.stringify(payload),
      timeout: 30000,
      onload: (response) => {
        if (response.status >= 200 && response.status < 300) {
          console.info('[Torn Racing Segment Collector] Upload succeeded', response.responseText);
          onDone?.(readJsonResponse(response.responseText));
          return;
        }

        alert(`Upload failed (${response.status}): ${response.responseText}`);
      },
      onerror: () => alert('Upload failed.'),
      ontimeout: () => alert('Upload timed out.'),
    });
  }

  function readJsonResponse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
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

    if (!titleBar) {
      return;
    }

    if (document.getElementById('trscControls')) {
      return;
    }

    const controls = document.createElement('div');
    controls.id = 'trscControls';
    controls.innerHTML = `
      <button id="trscCollectBtn" type="button">Collect</button>
    `;

    ensureCollectMenu();
    const infoWrap = titleBar.querySelector('.track-info-wrap');

    if (infoWrap) {
      infoWrap.parentNode.insertBefore(controls, infoWrap);
    } else {
      titleBar.appendChild(controls);
    }

    document.getElementById('trscCollectBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleCollectMenu();
      updateButtonLabel();
    });
    document.getElementById('trscUploadLatest').addEventListener('click', uploadLatestSnapshot);
    document.getElementById('trscUploadAll').addEventListener('click', uploadAllSnapshots);
    document.getElementById('trscSendJsonFile').addEventListener('click', sendJsonFile);
    document.getElementById('trscJson').addEventListener('click', downloadJson);
    document.getElementById('trscCsv').addEventListener('click', downloadCsv);
    document.getElementById('trscFactionMarkers').addEventListener('click', toggleFactionMarkers);
    document.getElementById('trscSetApiKey').addEventListener('click', configureTornApiKey);
    document.getElementById('trscClear').addEventListener('click', clearSnapshots);
    document.addEventListener('click', closeCollectMenu);
    window.addEventListener('resize', positionCollectMenu, { passive: true });
    window.addEventListener('scroll', positionCollectMenu, { passive: true });
    updateButtonLabel();
    updateFactionToggleButton();
    refreshFactionMarkers({ silent: true });
  }

  function ensureCollectMenu() {
    if (document.getElementById('trscMenu')) {
      return;
    }

    const menu = document.createElement('div');
    menu.id = 'trscMenu';
    menu.innerHTML = `
      <button id="trscUploadLatest" type="button">Upload latest</button>
      <button id="trscUploadAll" type="button">Upload all</button>
      <button id="trscSendJsonFile" type="button">Send JSON file</button>
      <button id="trscJson" type="button">JSON</button>
      <button id="trscCsv" type="button">CSV</button>
      <button id="trscFactionMarkers" type="button">Faction marks: OFF</button>
      <button id="trscSetApiKey" type="button">Set Torn API key</button>
      <button id="trscClear" type="button">Clear</button>
      <span id="trscStatus"></span>
      <span id="trscFactionStatus"></span>
    `;
    document.body.appendChild(menu);
  }

  function configureTornApiKey() {
    const current = String(GM_getValue(tornApiKey, '') || '');
    const entered = prompt('Torn API key for faction markers. Leave empty to remove it.', current);

    if (entered === null) {
      return;
    }

    const value = entered.trim();
    GM_setValue(tornApiKey, value);
    factionMarkerState.ownProfile = null;
    factionMarkerState.profileCache.clear();
    clearFactionMarkers();

    if (value) {
      GM_setValue(factionMarkersEnabledKey, true);
      updateFactionToggleButton();
      refreshFactionMarkers();
    } else {
      GM_setValue(factionMarkersEnabledKey, false);
      updateFactionToggleButton();
      updateFactionStatus(null);
    }
  }

  function toggleFactionMarkers() {
    const enabled = !areFactionMarkersEnabled();
    GM_setValue(factionMarkersEnabledKey, enabled);
    updateFactionToggleButton();

    if (!enabled) {
      clearFactionMarkers();
      updateFactionStatus(null);
      return;
    }

    refreshFactionMarkers();
  }

  async function refreshFactionMarkers(options = {}) {
    if (!areFactionMarkersEnabled()) {
      clearFactionMarkers();
      updateFactionToggleButton();
      return;
    }

    const apiKey = String(GM_getValue(tornApiKey, '') || '').trim();

    if (!apiKey) {
      clearFactionMarkers();
      updateFactionStatus(options.silent ? null : 'Set Torn API key first');
      return;
    }

    if (factionMarkerState.loading) {
      return;
    }

    const participants = getRaceParticipants();

    if (participants.length === 0) {
      factionMarkerState.lastRunAt = Date.now();
      updateFactionStatus(null);
      return;
    }

    factionMarkerState.loading = true;
    factionMarkerState.lastRunAt = Date.now();
    updateFactionStatus('Checking faction...');

    try {
      const ownProfile = await getOwnProfile(apiKey);
      const ownFaction = readFaction(ownProfile);

      if (!ownFaction?.id) {
        clearFactionMarkers();
        updateFactionStatus('No faction on profile');
        return;
      }

      const uniqueIds = [...new Set(participants.map((participant) => participant.tornUserId))];
      const profiles = await Promise.all(
        uniqueIds.map((tornUserId) => getProfileById(apiKey, tornUserId).catch(() => null)),
      );
      const profileById = new Map(uniqueIds.map((tornUserId, index) => [tornUserId, profiles[index]]));
      let matches = 0;

      for (const participant of participants) {
        const profile = profileById.get(participant.tornUserId);
        const faction = readFaction(profile);

        if (faction?.id && faction.id === ownFaction.id) {
          markParticipant(participant.nameElement, readFactionShorthand(faction));
          matches += 1;
        } else {
          unmarkParticipant(participant.nameElement);
        }
      }

      updateFactionStatus(matches > 0 ? `${matches} faction marked` : 'No faction matches');
    } catch (error) {
      console.warn('[Torn Racing Segment Collector] Could not refresh faction markers', error);
      updateFactionStatus('Faction check failed');
    } finally {
      factionMarkerState.loading = false;
    }
  }

  function areFactionMarkersEnabled() {
    return Boolean(GM_getValue(factionMarkersEnabledKey, false));
  }

  function updateFactionToggleButton() {
    const button = document.getElementById('trscFactionMarkers');

    if (!button) {
      return;
    }

    const enabled = areFactionMarkersEnabled();
    button.textContent = `Faction marks: ${enabled ? 'ON' : 'OFF'}`;
    button.classList.toggle('trscActive', enabled);
  }

  function getRaceParticipants() {
    const list = document.querySelector('#leaderBoard') || document.querySelector('.drivers-list');

    if (!list) {
      return [];
    }

    const seen = new Set();
    const participants = [];

    for (const row of list.querySelectorAll(':scope > li')) {
      const tornUserId = readTornUserIdFromRaceRow(row);
      const nameElement = row.querySelector('.name span') || row.querySelector('.name') || row.querySelector('a[href]');

      if (!tornUserId || !nameElement || seen.has(tornUserId)) {
        continue;
      }

      seen.add(tornUserId);
      participants.push({ nameElement, tornUserId });
    }

    for (const link of list.querySelectorAll('a[href]')) {
      const tornUserId = readTornUserIdFromUrl(link.getAttribute('href'));

      if (!tornUserId || seen.has(tornUserId)) {
        continue;
      }

      seen.add(tornUserId);
      participants.push({ nameElement: link, tornUserId });
    }

    return participants;
  }

  function readTornUserIdFromRaceRow(row) {
    const idMatch = String(row.id || '').match(/^lbr-(\d+)$/i);

    if (idMatch) {
      return Number(idMatch[1]);
    }

    const dataIdMatch = String(row.getAttribute('data-id') || '').match(/-(\d+)$/);
    const tornUserId = dataIdMatch ? Number(dataIdMatch[1]) : NaN;
    return Number.isInteger(tornUserId) && tornUserId > 0 ? tornUserId : null;
  }

  function readTornUserIdFromUrl(url) {
    const match = String(url || '').match(/[?&]XID=(\d+)/i) || String(url || '').match(/\/profiles\.php\?(?:[^#]*&)?XID=(\d+)/i);
    const tornUserId = match ? Number(match[1]) : NaN;
    return Number.isInteger(tornUserId) && tornUserId > 0 ? tornUserId : null;
  }

  async function getOwnProfile(apiKey) {
    if (factionMarkerState.ownProfile) {
      return factionMarkerState.ownProfile;
    }

    const payload = await tornGet(apiKey, '/user', { selections: 'profile' });
    const profile = payload.profile || payload;
    factionMarkerState.ownProfile = profile;
    return profile;
  }

  async function getProfileById(apiKey, tornUserId) {
    const cached = factionMarkerState.profileCache.get(tornUserId);

    if (cached && Date.now() - cached.cachedAt < profileCacheTtlMs) {
      return cached.profile;
    }

    const payload = await tornGet(apiKey, `/user/${tornUserId}/profile`);
    const profile = payload.profile || payload;
    factionMarkerState.profileCache.set(tornUserId, { cachedAt: Date.now(), profile });
    return profile;
  }

  function tornGet(apiKey, path, params = {}) {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(normalizedPath, `${tornApiBaseUrl}/`);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url.toString(),
        headers: {
          accept: 'application/json',
          Authorization: `ApiKey ${apiKey}`,
        },
        timeout: 30000,
        onload: (response) => {
          const payload = readJsonResponse(response.responseText) || {};

          if (response.status >= 200 && response.status < 300 && !payload.error) {
            resolve(payload);
            return;
          }

          reject(new Error(payload.error?.error || `Torn API request failed (${response.status})`));
        },
        onerror: () => reject(new Error('Torn API request failed')),
        ontimeout: () => reject(new Error('Torn API request timed out')),
      });
    });
  }

  function readFaction(profile) {
    if (!profile || typeof profile !== 'object') {
      return null;
    }

    const faction = profile.faction && typeof profile.faction === 'object' ? profile.faction : profile;
    const id = Number(faction.id ?? faction.faction_id ?? profile.faction_id ?? profile.factionID);

    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    return {
      id,
      name: String(faction.name ?? faction.faction_name ?? profile.faction_name ?? ''),
      tag: String(faction.tag ?? faction.short_name ?? faction.shortName ?? faction.abbreviation ?? ''),
    };
  }

  function readFactionShorthand(faction) {
    if (faction.tag.trim()) {
      return faction.tag.trim().slice(0, 8);
    }

    const initials = faction.name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

    return (initials || 'FAC').slice(0, 4);
  }

  function markParticipant(nameElement, shorthand) {
    const existing = nameElement.parentNode?.querySelector?.(':scope > .trscFactionMarker');

    if (existing) {
      existing.textContent = shorthand;
      return;
    }

    const marker = document.createElement('span');
    marker.className = 'trscFactionMarker';
    marker.textContent = shorthand;
    marker.title = 'Same faction as you';
    nameElement.insertAdjacentElement('afterend', marker);
  }

  function unmarkParticipant(nameElement) {
    const marker = nameElement.parentNode?.querySelector?.(':scope > .trscFactionMarker');
    marker?.remove();
  }

  function clearFactionMarkers() {
    for (const marker of document.querySelectorAll('.trscFactionMarker')) {
      marker.remove();
    }
  }

  function updateFactionStatus(message) {
    const status = document.getElementById('trscFactionStatus');

    if (status) {
      status.textContent = message || '';
    }
  }

  function toggleCollectMenu() {
    const menu = document.getElementById('trscMenu');

    if (!menu) {
      return;
    }

    menu.classList.toggle('trscOpen');
    positionCollectMenu();
  }

  function positionCollectMenu() {
    const button = document.getElementById('trscCollectBtn');
    const menu = document.getElementById('trscMenu');

    if (!button || !menu || !menu.classList.contains('trscOpen')) {
      return;
    }

    const rect = button.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 130;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));

    menu.style.left = `${left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  }

  function closeCollectMenu(event) {
    const controls = document.getElementById('trscControls');
    const menu = document.getElementById('trscMenu');

    if (!controls || controls.contains(event.target) || menu?.contains(event.target)) {
      return;
    }

    menu?.classList.remove('trscOpen');
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
      margin: 3px 5px 0 6px;
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
      position: fixed;
      display: none;
      min-width: 122px;
      z-index: 2147483647;
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
    #trscMenu button.trscActive {
      border-color: #52df82;
      background: #173a24;
      color: #91d9a9;
      font-weight: bold;
    }
    #trscStatus {
      display: block;
      padding: 2px 3px 0;
      color: #bbb;
      white-space: nowrap;
    }
    #trscFactionStatus {
      display: block;
      padding: 0 3px 2px;
      color: #91d9a9;
      white-space: nowrap;
    }
    .trscFactionMarker {
      display: inline-block;
      margin-left: 4px;
      padding: 0 4px;
      border: 1px solid #1c8d45;
      border-radius: 3px;
      background: #173a24;
      color: #91d9a9;
      font: 10px Arial, sans-serif;
      font-weight: bold;
      line-height: 12px;
      vertical-align: middle;
    }
    #leaderBoard .name .trscFactionMarker {
      float: right;
      margin: 2px 4px 0 6px;
    }
  `);

  installXhrCapture();

  function bootControls() {
    if (!document.body) {
      setTimeout(bootControls, 100);
      return;
    }

    ensureControls();
    setInterval(() => {
      ensureControls();

      if (Date.now() - factionMarkerState.lastRunAt > 10000) {
        refreshFactionMarkers({ silent: true });
      }
    }, 1000);
  }

  bootControls();
})();
