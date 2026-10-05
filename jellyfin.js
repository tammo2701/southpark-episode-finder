// Settings, Jellyfin Cast & Two-Way Watched Sync for South Park Episode Finder
(function () {
  const STORAGE_KEY_JF = 'sp_jellyfin_cfg';
  const STORAGE_KEY_PREFS = 'sp_user_prefs';

  function getDeviceId() {
    try {
      let id = localStorage.getItem('sp_jf_device_id');
      if (!id) {
        id = 'sp-finder-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now().toString(36);
        localStorage.setItem('sp_jf_device_id', id);
      }
      return id;
    } catch (_) {
      return 'sp-finder-web-client';
    }
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch (_) {
      return { ...fallback };
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  }

  const jfConfig = loadJson(STORAGE_KEY_JF, {
    serverUrl: '',
    authMode: 'apikey', // 'apikey' | 'userpass'
    username: '',
    accessToken: '',
    userId: '',
    serverName: '',
    seriesId: '',
    selectedSessionId: '',
    selectedDeviceName: '',
    connected: false,
    lastSyncCount: 0,
    episodeMap: {} // "S8E7" -> { id, name, played, fav }
  });

  const userPrefs = loadJson(STORAGE_KEY_PREFS, {
    langMode: localStorage.getItem('sp_lang_mode') || 'auto', // 'auto' | 'de' | 'en'
    defaultRole: 'main', // 'main' | 'all'
    showDualLang: true,
    syncWatchedWithJf: true,
    pageSize: 60
  });

  let activeSessions = [];
  let watchedSyncListeners = [];

  function onWatchedSync(cb) {
    if (typeof cb === 'function') watchedSyncListeners.push(cb);
  }

  function notifyWatchedListeners(epMap) {
    for (const cb of watchedSyncListeners) {
      try { cb(epMap); } catch (_) {}
    }
  }

  function cleanServerUrl(url) {
    let u = (url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) {
      u = 'http://' + u;
    }
    u = u.replace(/\/web\/index\.html.*$/i, '');
    u = u.replace(/\/web\/?$/i, '');
    return u.replace(/\/+$/, '');
  }

  function buildEmbyAuthHeader(token) {
    const devId = getDeviceId();
    let hdr = `MediaBrowser Client="South Park Episode Finder", Device="Web App", DeviceId="${devId}", Version="1.0.0"`;
    if (token) {
      hdr += `, Token="${token}"`;
    }
    return hdr;
  }

  function appendTokenToUrl(rawUrl, token) {
    if (!token) return rawUrl;
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}api_key=${encodeURIComponent(token)}`;
  }

  // Probe whether the browser blocks HTTP requests from HTTPS due to "Insecure Content" (Mixed Content)
  // vs "Local Network Access" vs Server unreachable
  async function diagnoseConnectionProblem(baseUrl) {
    const isDe = document.documentElement.lang === 'de';
    const pageIsHttps = window.location.protocol === 'https:';
    const targetIsHttp = baseUrl.toLowerCase().startsWith('http://');

    if (pageIsHttps && targetIsHttp) {
      // Try no-cors probe to see if the browser blocks the request before it even leaves (Mixed Content)
      try {
        await fetch(`${baseUrl}/System/Info/Public`, { mode: 'no-cors', cache: 'no-store' });
        // If no-cors succeeds, Mixed Content & Local Network ARE allowed, so it was a CORS header or endpoint issue!
      } catch (_) {
        // Browser blocked even a no-cors request -> "Insecure content" (Unsichere Inhalte) is still blocked in Chrome/Edge/Brave!
        throw new Error(isDe
          ? `WICHTIG: „Lokales Netzwerk“ allein reicht bei HTTPS (${window.location.hostname}) nicht aus – der Browser blockiert noch „Unsichere Inhalte“ (HTTP). Lösung in 3 Klicks: 1. Klicke links in der Adresszeile auf das Einstellungs-Symbol \u2192 „Website-Einstellungen“. 2. Scrolle zu „Unsichere Inhalte“ (Insecure content) und stelle es von „Blockieren“ auf „Zulassen“. 3. Lade die Seite neu.`
          : `IMPORTANT: Allowing "Local Network" alone is not enough on HTTPS (${window.location.hostname}) — the browser is still blocking "Insecure content" (HTTP). Fix in 3 clicks: 1. Click the tune/lock icon in the address bar \u2192 "Site settings". 2. Scroll to "Insecure content" and change it from "Block" to "Allow". 3. Reload this page.`);
      }
    }

    throw new Error(isDe
      ? `Jellyfin-Server unter „${baseUrl}“ nicht erreichbar. Bitte prüfe IP & Port (z.B. :8096) und ob du im selben WLAN bist.`
      : `Could not reach Jellyfin server at "${baseUrl}". Please check IP & port (e.g. :8096) and ensure you are on the same network.`);
  }

  // Smart Jellyfin Fetch:
  // Avoids CORS preflight (OPTIONS) whenever possible because Jellyfin returns 405 Method Not Allowed on OPTIONS from external origins unless specially configured.
  async function jfFetch(path, options = {}) {
    const base = cleanServerUrl(jfConfig.serverUrl);
    if (!base) throw new Error('Server URL missing');
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    const method = (options.method || 'GET').toUpperCase();
    const token = options.token !== undefined ? options.token : jfConfig.accessToken;
    const rawUrl = `${base}${cleanPath}`;
    const urlWithToken = appendTokenToUrl(rawUrl, token);
    const isDe = document.documentElement.lang === 'de';

    // Attempt 1: Pure CORS-Simple Request (ZERO custom headers, no application/json Content-Type on empty body)
    // This completely skips the browser's OPTIONS preflight request!
    if (!cleanPath.includes('/Users/AuthenticateByName') && method !== 'DELETE') {
      try {
        const simpleOpts = { method };
        if (options.body) {
          // Use text/plain if possible or application/json
          simpleOpts.headers = { 'Content-Type': 'application/json' };
          simpleOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        }
        const res = await fetch(urlWithToken, simpleOpts);
        if (res.ok) {
          const text = await res.text();
          return text ? JSON.parse(text) : {};
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(isDe
            ? `Zugriff verweigert (HTTP ${res.status}): Bitte API-Key oder Zugangsdaten prüfen.`
            : `Access denied (HTTP ${res.status}): Please check your API key or credentials.`);
        }
      } catch (err1) {
        if (err1 && err1.message && (err1.message.includes('401') || err1.message.includes('403'))) {
          throw err1;
        }
      }
    }

    // Attempt 2: Full X-Emby-Authorization header request
    const fullHeaders = {
      'Accept': 'application/json',
      'X-Emby-Authorization': buildEmbyAuthHeader(token),
      ...(options.headers || {})
    };
    if (token) {
      fullHeaders['X-Emby-Token'] = token;
    }
    if (options.body && !fullHeaders['Content-Type']) {
      fullHeaders['Content-Type'] = 'application/json';
    }

    try {
      const res2 = await fetch(rawUrl, {
        method,
        headers: fullHeaders,
        body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
      });
      if (!res2.ok) {
        if (res2.status === 401 || res2.status === 403) {
          throw new Error(isDe
            ? `Anmeldung fehlgeschlagen (HTTP ${res2.status}): Ungültiger Benutzername, Passwort oder API-Key.`
            : `Authentication failed (HTTP ${res2.status}): Invalid username, password, or API key.`);
        }
        const errText = await res2.text().catch(() => '');
        throw new Error(`HTTP ${res2.status}: ${errText || res2.statusText}`);
      }
      const text2 = await res2.text();
      return text2 ? JSON.parse(text2) : {};
    } catch (directErr) {
      if (directErr && directErr.message && directErr.message.startsWith('HTTP ')) {
        throw directErr;
      }
      if (directErr && directErr.message && (directErr.message.includes('401') || directErr.message.includes('403'))) {
        throw directErr;
      }

      // If /Users/AuthenticateByName failed due to CORS preflight (because Jellyfin blocks custom X-Emby-Authorization on OPTIONS from https://southfinder.pages.dev)
      if (cleanPath.includes('/Users/AuthenticateByName')) {
        // First check if Mixed Content ("Unsichere Inhalte") is the blocker
        await diagnoseConnectionProblem(base);
        // If Mixed Content is NOT blocked (no-cors succeeded), then Jellyfin rejected the OPTIONS preflight for /Users/AuthenticateByName!
        throw new Error(isDe
          ? 'Dein Jellyfin-Server ist erreichbar, blockiert aber die Passwort-Anmeldung von externen Domains (CORS-Preflight). Bitte wechsle oben auf „API-Key / Token“ (in Jellyfin unter Dashboard \u2192 API-Schlüssel erstellen) – damit funktioniert die Verbindung sofort ohne CORS-Blockade!'
          : 'Your Jellyfin server is reachable, but blocks password login from external domains (CORS preflight). Please switch to "API Key / Token" above (create one in Jellyfin under Dashboard \u2192 API Keys) — it works immediately without CORS preflight!');
      }

      await diagnoseConnectionProblem(base);
      throw directErr;
    }
  }

  // Authenticate by Username & Password OR API Key
  async function connectAndSyncJellyfin(params) {
    jfConfig.serverUrl = cleanServerUrl(params.serverUrl);
    jfConfig.authMode = params.authMode;
    jfConfig.username = (params.username || '').trim();

    if (!jfConfig.serverUrl) {
      throw new Error(document.documentElement.lang === 'de' ? 'Bitte gib deine Jellyfin Server-URL ein.' : 'Please enter your Jellyfin Server URL.');
    }

    // 1. Public server info check (Simple GET - no preflight!)
    const pubInfo = await jfFetch('/System/Info/Public', { token: '' });
    jfConfig.serverName = pubInfo.ServerName || 'Jellyfin Server';

    // 2. Authenticate
    if (params.authMode === 'userpass') {
      const authData = await jfFetch('/Users/AuthenticateByName', {
        method: 'POST',
        token: '',
        body: {
          Username: jfConfig.username,
          Pw: params.password || ''
        }
      });
      if (!authData || !authData.AccessToken) {
        throw new Error(document.documentElement.lang === 'de' ? 'Anmeldung fehlgeschlagen: Kein AccessToken erhalten.' : 'Authentication failed: No AccessToken received.');
      }
      jfConfig.accessToken = authData.AccessToken;
      jfConfig.userId = authData.User ? authData.User.Id : '';
    } else {
      const apiKey = (params.apiKey || '').trim();
      if (!apiKey) {
        throw new Error(document.documentElement.lang === 'de' ? 'Bitte API-Key / Token eingeben.' : 'Please enter an API Key / Token.');
      }
      jfConfig.accessToken = apiKey;
      const users = await jfFetch('/Users', { token: apiKey });
      if (Array.isArray(users) && users.length > 0) {
        const matchUser = jfConfig.username
          ? users.find(u => (u.Name || '').toLowerCase() === jfConfig.username.toLowerCase()) || users[0]
          : users[0];
        jfConfig.userId = matchUser.Id;
        jfConfig.username = matchUser.Name || jfConfig.username;
      }
    }

    // 3. Scan South Park Series, Episodes & Played/Watched status in Jellyfin library
    await syncSouthParkEpisodes();

    // 4. Fetch available TV / Cast Sessions
    await refreshSessions().catch(() => []);

    jfConfig.connected = true;
    saveJson(STORAGE_KEY_JF, jfConfig);
    return jfConfig;
  }

  // Fetches all South Park episodes from Jellyfin along with UserData.Played & UserData.IsFavorite
  async function syncSouthParkEpisodes() {
    const epMap = {};
    let watchedCount = 0;

    if (!jfConfig.serverUrl || !jfConfig.accessToken) {
      return epMap;
    }

    if (!jfConfig.userId) {
      try {
        const users = await jfFetch('/Users');
        if (Array.isArray(users) && users.length > 0) {
          jfConfig.userId = users[0].Id;
        }
      } catch (_) {}
    }

    const userPath = jfConfig.userId ? `/Users/${jfConfig.userId}/Items` : '/Items';
    const userQuery = jfConfig.userId ? `&UserId=${encodeURIComponent(jfConfig.userId)}` : '';

    const recordItems = (items) => {
      for (const item of items) {
        const s = item.ParentIndexNumber !== undefined ? item.ParentIndexNumber : -1;
        const e = item.IndexNumber !== undefined ? item.IndexNumber : -1;
        if (s >= 0 && e >= 0) {
          const played = Boolean(item.UserData && item.UserData.Played);
          const fav = Boolean(item.UserData && item.UserData.IsFavorite);
          if (played) watchedCount++;
          epMap[`S${s}E${e}`] = {
            id: item.Id,
            name: item.Name || '',
            played,
            fav
          };
        }
      }
    };

    try {
      const seriesRes = await jfFetch(`${userPath}?IncludeItemTypes=Series&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}`);
      const seriesList = (seriesRes && seriesRes.Items) || [];
      const spSeries = seriesList.find(s => (s.Name || '').toLowerCase().includes('south park')) || seriesList[0];

      if (spSeries && spSeries.Id) {
        jfConfig.seriesId = spSeries.Id;
        const epsRes = await jfFetch(`/Shows/${spSeries.Id}/Episodes?Fields=UserData${userQuery}`);
        recordItems((epsRes && epsRes.Items) || []);
      }

      if (Object.keys(epMap).length === 0) {
        const epsRes = await jfFetch(`${userPath}?IncludeItemTypes=Episode&Recursive=true&Fields=UserData&SearchTerm=${encodeURIComponent('South Park')}&Limit=500`);
        const items = ((epsRes && epsRes.Items) || []).filter(it =>
          !it.SeriesName || it.SeriesName.toLowerCase().includes('south park')
        );
        recordItems(items);
      }
    } catch (_) {}

    jfConfig.episodeMap = epMap;
    jfConfig.lastSyncCount = watchedCount;
    saveJson(STORAGE_KEY_JF, jfConfig);
    notifyWatchedListeners(epMap);
    return epMap;
  }

  // Push local Watched toggle (true/false) to Jellyfin Server for a specific episode
  async function setEpisodeWatchedOnJellyfin(ep, isWatched) {
    if (!jfConfig.connected || !jfConfig.serverUrl || !jfConfig.accessToken || !jfConfig.userId) {
      return false;
    }
    if (userPrefs.syncWatchedWithJf === false) {
      return false;
    }
    try {
      const itemId = await resolveEpisodeItemId(ep);
      if (!itemId) return false;
      const key = `S${ep.s}E${ep.e}`;
      await jfFetch(`/Users/${encodeURIComponent(jfConfig.userId)}/PlayedItems/${encodeURIComponent(itemId)}`, {
        method: isWatched ? 'POST' : 'DELETE'
      });
      if (jfConfig.episodeMap && jfConfig.episodeMap[key]) {
        jfConfig.episodeMap[key].played = Boolean(isWatched);
        saveJson(STORAGE_KEY_JF, jfConfig);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function refreshSessions() {
    if (!jfConfig.serverUrl || !jfConfig.accessToken) {
      activeSessions = [];
      return [];
    }
    const list = await jfFetch('/Sessions');
    if (!Array.isArray(list)) {
      activeSessions = [];
      return [];
    }
    const myDevId = getDeviceId();
    const remoteCapable = list.filter(s => s.DeviceId !== myDevId && s.SupportsRemoteControl !== false);
    activeSessions = remoteCapable.length > 0 ? remoteCapable : list.filter(s => s.DeviceId !== myDevId);

    if (activeSessions.length > 0) {
      const stillExists = activeSessions.find(s => s.Id === jfConfig.selectedSessionId);
      if (!stillExists) {
        jfConfig.selectedSessionId = activeSessions[0].Id;
        jfConfig.selectedDeviceName = `${activeSessions[0].DeviceName || activeSessions[0].Client || 'TV'} (${activeSessions[0].Client || 'Jellyfin'})`;
        saveJson(STORAGE_KEY_JF, jfConfig);
      }
    }
    return activeSessions;
  }

  async function resolveEpisodeItemId(ep) {
    const key = `S${ep.s}E${ep.e}`;
    if (jfConfig.episodeMap && jfConfig.episodeMap[key] && jfConfig.episodeMap[key].id) {
      return jfConfig.episodeMap[key].id;
    }
    const userPath = jfConfig.userId ? `/Users/${jfConfig.userId}/Items` : '/Items';
    const searchRes = await jfFetch(`${userPath}?IncludeItemTypes=Episode&Recursive=true&Fields=UserData&SearchTerm=${encodeURIComponent(ep.title)}&Limit=20`);
    const items = (searchRes && searchRes.Items) || [];
    const exact = items.find(it =>
      (it.ParentIndexNumber === ep.s && it.IndexNumber === ep.e) ||
      (it.Name || '').toLowerCase() === ep.title.toLowerCase()
    ) || items[0];

    if (exact && exact.Id) {
      jfConfig.episodeMap[key] = {
        id: exact.Id,
        name: exact.Name || ep.title,
        played: Boolean(exact.UserData && exact.UserData.Played),
        fav: Boolean(exact.UserData && exact.UserData.IsFavorite)
      };
      saveJson(STORAGE_KEY_JF, jfConfig);
      return exact.Id;
    }
    return null;
  }

  async function castEpisodeToTv(ep, sessionIdOverride) {
    const isDe = document.documentElement.lang === 'de';
    if (!jfConfig.connected || !jfConfig.serverUrl || !jfConfig.accessToken) {
      throw new Error(isDe ? 'Jellyfin ist noch nicht verbunden.' : 'Jellyfin is not connected yet.');
    }

    const targetSessionId = sessionIdOverride || jfConfig.selectedSessionId;
    if (!targetSessionId) {
      throw new Error(isDe
        ? 'Kein Ziel-TV ausgewählt. Bitte öffne die Jellyfin-App auf deinem TV und klicke auf „TVs suchen“.'
        : 'No target TV selected. Please open the Jellyfin app on your TV and click "Scan TVs".');
    }

    const itemId = await resolveEpisodeItemId(ep);
    if (!itemId) {
      throw new Error(isDe
        ? `Folge S${ep.s}E${ep.e} („${ep.title}“) wurde in deiner Jellyfin-Mediathek nicht gefunden.`
        : `Episode S${ep.s}E${ep.e} ("${ep.title}") was not found in your Jellyfin library.`);
    }

    await jfFetch(`/Sessions/${encodeURIComponent(targetSessionId)}/Playing?ItemIds=${encodeURIComponent(itemId)}&PlayCommand=PlayNow`, {
      method: 'POST'
    });

    return { itemId, sessionId: targetSessionId };
  }

  async function sendRemoteCommand(command, sessionIdOverride) {
    const targetSessionId = sessionIdOverride || jfConfig.selectedSessionId;
    if (!targetSessionId) return;
    await jfFetch(`/Sessions/${encodeURIComponent(targetSessionId)}/Playing/${encodeURIComponent(command)}`, {
      method: 'POST'
    });
  }

  function disconnectJellyfin() {
    jfConfig.accessToken = '';
    jfConfig.userId = '';
    jfConfig.connected = false;
    jfConfig.episodeMap = {};
    jfConfig.selectedSessionId = '';
    jfConfig.selectedDeviceName = '';
    jfConfig.lastSyncCount = 0;
    activeSessions = [];
    saveJson(STORAGE_KEY_JF, jfConfig);
  }

  window.SP_JELLYFIN = {
    jfConfig,
    userPrefs,
    savePrefs: () => saveJson(STORAGE_KEY_PREFS, userPrefs),
    saveJfConfig: () => saveJson(STORAGE_KEY_JF, jfConfig),
    connectAndSyncJellyfin,
    syncSouthParkEpisodes,
    setEpisodeWatchedOnJellyfin,
    onWatchedSync,
    refreshSessions,
    getActiveSessions: () => activeSessions,
    resolveEpisodeItemId,
    castEpisodeToTv,
    sendRemoteCommand,
    disconnectJellyfin
  };
})();
