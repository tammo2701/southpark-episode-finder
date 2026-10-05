// Settings, Jellyfin Cast & Two-Way Watched Sync for South Park Episode Finder
// Compatible with Jellyfin 10.8, 10.9, 10.10, 10.11, 10.12 / 12.x+ (Modern Authorization: MediaBrowser scheme)
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
    authMode: 'userpass', // 'userpass' | 'apikey'
    username: '',
    accessToken: '',
    userId: '',
    serverName: '',
    serverVersion: '',
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

  // Modern Jellyfin 10.9 - 10.12 / 12.x+ Authorization Header:
  // Uses standard `Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."`
  function buildMediaBrowserAuthHeader(token) {
    const devId = getDeviceId();
    let hdr = `MediaBrowser Client="South Park Episode Finder", Device="Web Browser", DeviceId="${devId}", Version="1.2.0"`;
    if (token) {
      hdr += `, Token="${token}"`;
    }
    return hdr;
  }

  function appendApiKeyToUrl(rawUrl, token) {
    if (!token) return rawUrl;
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}ApiKey=${encodeURIComponent(token)}`;
  }

  async function diagnoseConnectionProblem(baseUrl) {
    const isDe = document.documentElement.lang === 'de';
    const pageIsHttps = window.location.protocol === 'https:';
    const targetIsHttp = baseUrl.toLowerCase().startsWith('http://');

    if (pageIsHttps && targetIsHttp) {
      try {
        await fetch(`${baseUrl}/System/Info/Public`, { mode: 'no-cors', cache: 'no-store' });
      } catch (_) {
        throw new Error(isDe
          ? `Der Browser blockiert „Unsichere Inhalte“ (HTTP) auf dieser HTTPS-Seite. Klicke links in der Adresszeile auf das Einstellungs-Symbol \u2192 „Website-Einstellungen“ \u2192 stelle „Unsichere Inhalte“ (Insecure content) auf „Zulassen“ und lade die Seite neu.`
          : `The browser is blocking "Insecure content" (HTTP) on this HTTPS page. Click the tune/lock icon in the address bar \u2192 "Site settings" \u2192 set "Insecure content" to "Allow" and reload.`);
      }
    }

    throw new Error(isDe
      ? `Jellyfin-Server unter „${baseUrl}“ nicht erreichbar. Bitte prüfe IP & Port (z.B. :8096) und ob du im selben Netzwerk bist.`
      : `Could not reach Jellyfin server at "${baseUrl}". Please check IP & port (e.g. :8096) and your network connection.`);
  }

  // Core Jellyfin API caller supporting Jellyfin 10.8 -> 12.x+
  // 1. Primary: Modern standard `Authorization: MediaBrowser ...` header (required when EnableLegacyAuthorization is false in Jellyfin 10.12 / 12.x).
  // 2. Fallback: Legacy `X-Emby-Authorization` + `ApiKey` query parameter for older setups or strict proxies.
  async function jfFetch(path, options = {}) {
    const base = cleanServerUrl(jfConfig.serverUrl);
    if (!base) throw new Error('Server URL missing');
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    const method = (options.method || 'GET').toUpperCase();
    const token = options.token !== undefined ? options.token : jfConfig.accessToken;
    const rawUrl = `${base}${cleanPath}`;
    const isDe = document.documentElement.lang === 'de';

    const authValue = buildMediaBrowserAuthHeader(token);

    // Attempt 1: Modern Jellyfin 10.11 / 10.12 / 12.x standard `Authorization` header
    const modernHeaders = {
      'Accept': 'application/json',
      'Authorization': authValue,
      ...(options.headers || {})
    };
    if (options.body !== undefined) {
      modernHeaders['Content-Type'] = 'application/json';
    }

    let lastHttpStatus = 0;
    let lastHttpErrorText = '';

    try {
      const res1 = await fetch(rawUrl, {
        method,
        headers: modernHeaders,
        body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
      });

      if (res1.ok) {
        const text = await res1.text();
        return text ? JSON.parse(text) : {};
      }

      lastHttpStatus = res1.status;
      lastHttpErrorText = await res1.text().catch(() => '');

      if (res1.status === 401 || res1.status === 403) {
        throw new Error(isDe
          ? `Anmeldung abgelehnt (HTTP ${res1.status}): Bitte Benutzername, Passwort oder API-Key prüfen.`
          : `Authentication rejected (HTTP ${res1.status}): Please check your username, password, or API key.`);
      }
    } catch (err1) {
      if (err1 && err1.message && (err1.message.includes('401') || err1.message.includes('403'))) {
        throw err1;
      }
    }

    // Attempt 2: Query parameter `?ApiKey=...` without custom headers (for API key mode or endpoints that don't require session DeviceId)
    if (token && !cleanPath.includes('/Users/AuthenticateByName')) {
      try {
        const urlWithKey = appendApiKeyToUrl(rawUrl, token);
        const simpleHeaders = { 'Accept': 'application/json' };
        if (options.body !== undefined) {
          simpleHeaders['Content-Type'] = 'application/json';
        }
        const res2 = await fetch(urlWithKey, {
          method,
          headers: simpleHeaders,
          body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
        });
        if (res2.ok) {
          const text2 = await res2.text();
          return text2 ? JSON.parse(text2) : {};
        }
      } catch (_) {}
    }

    // Attempt 3: Both `Authorization` and `X-Emby-Authorization` (for older Jellyfin 10.8 / Emby compatibility)
    try {
      const dualHeaders = {
        'Accept': 'application/json',
        'Authorization': authValue,
        'X-Emby-Authorization': authValue,
        ...(options.headers || {})
      };
      if (options.body !== undefined) {
        dualHeaders['Content-Type'] = 'application/json';
      }
      const res3 = await fetch(rawUrl, {
        method,
        headers: dualHeaders,
        body: options.body !== undefined ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
      });
      if (res3.ok) {
        const text3 = await res3.text();
        return text3 ? JSON.parse(text3) : {};
      }
      lastHttpStatus = res3.status;
      lastHttpErrorText = await res3.text().catch(() => '');
    } catch (networkErr) {
      if (!lastHttpStatus) {
        await diagnoseConnectionProblem(base);
        throw networkErr;
      }
    }

    throw new Error(`HTTP ${lastHttpStatus}: ${lastHttpErrorText || 'Error processing request'} (${cleanPath})`);
  }

  // Authenticate by Username & Password OR API Key
  async function connectAndSyncJellyfin(params) {
    const isDe = document.documentElement.lang === 'de';
    jfConfig.serverUrl = cleanServerUrl(params.serverUrl);
    jfConfig.authMode = params.authMode;
    jfConfig.username = (params.username || '').trim();

    if (!jfConfig.serverUrl) {
      throw new Error(isDe ? 'Bitte gib deine Jellyfin Server-URL ein.' : 'Please enter your Jellyfin Server URL.');
    }

    // 1. Public server info check
    const pubInfo = await jfFetch('/System/Info/Public', { token: '' });
    jfConfig.serverName = pubInfo.ServerName || 'Jellyfin Server';
    jfConfig.serverVersion = pubInfo.Version || '';

    // 2. Authenticate
    if (params.authMode === 'userpass') {
      if (!jfConfig.username) {
        throw new Error(isDe ? 'Bitte gib deinen Jellyfin-Benutzernamen ein.' : 'Please enter your Jellyfin username.');
      }
      const authData = await jfFetch('/Users/AuthenticateByName', {
        method: 'POST',
        token: '',
        body: {
          Username: jfConfig.username,
          Pw: params.password || ''
        }
      });
      if (!authData || !authData.AccessToken) {
        throw new Error(isDe ? 'Anmeldung fehlgeschlagen: Kein AccessToken erhalten.' : 'Authentication failed: No AccessToken received.');
      }
      jfConfig.accessToken = authData.AccessToken;
      jfConfig.userId = authData.User ? authData.User.Id : '';
    } else {
      const apiKey = (params.apiKey || '').trim();
      if (!apiKey) {
        throw new Error(isDe ? 'Bitte API-Key / Token eingeben.' : 'Please enter an API Key / Token.');
      }
      jfConfig.accessToken = apiKey;

      // Resolve User ID:
      // First try /Users/Me (works if the token is a user session token), then fallback to /Users (works for Admin API Keys)
      let resolvedUserId = '';
      try {
        const me = await jfFetch('/Users/Me', { token: apiKey });
        if (me && me.Id) {
          resolvedUserId = me.Id;
          jfConfig.username = me.Name || jfConfig.username;
        }
      } catch (_) {}

      if (!resolvedUserId) {
        try {
          const users = await jfFetch('/Users', { token: apiKey });
          if (Array.isArray(users) && users.length > 0) {
            const matchUser = jfConfig.username
              ? users.find(u => (u.Name || '').toLowerCase() === jfConfig.username.toLowerCase()) || users[0]
              : users[0];
            resolvedUserId = matchUser.Id;
            jfConfig.username = matchUser.Name || jfConfig.username;
          }
        } catch (_) {}
      }
      jfConfig.userId = resolvedUserId;
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
  // Uses modern Jellyfin 10.9 - 12.x `/Items` and `/Shows/{seriesId}/Episodes` parameters
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

    const userParam = jfConfig.userId ? `userId=${encodeURIComponent(jfConfig.userId)}&` : '';

    const recordItems = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const s = item.ParentIndexNumber !== undefined ? item.ParentIndexNumber : -1;
        const e = item.IndexNumber !== undefined ? item.IndexNumber : -1;
        if (s >= 0 && e >= 0) {
          const played = Boolean(item.UserData && item.UserData.Played);
          const fav = Boolean(item.UserData && item.UserData.IsFavorite);
          if (played && (!epMap[`S${s}E${e}`] || !epMap[`S${s}E${e}`].played)) {
            watchedCount++;
          }
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
      // 1. Find South Park Series item via top-level /Items endpoint (compatible with Jellyfin 10.8 -> 12.x+)
      const seriesRes = await jfFetch(`/Items?${userParam}IncludeItemTypes=Series&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}`);
      const seriesList = (seriesRes && seriesRes.Items) || [];
      const spSeries = seriesList.find(s => (s.Name || '').toLowerCase().includes('south park')) || seriesList[0];

      if (spSeries && spSeries.Id) {
        jfConfig.seriesId = spSeries.Id;
        // Fetch episodes for this series (UserData is included automatically when userId is passed)
        try {
          const epsRes = await jfFetch(`/Shows/${encodeURIComponent(spSeries.Id)}/Episodes?${userParam}EnableUserData=true`);
          recordItems((epsRes && epsRes.Items) || []);
        } catch (_) {
          // Fallback to /Items with ParentId if /Shows/{id}/Episodes throws 400 on custom setups
          const epsFallback = await jfFetch(`/Items?${userParam}ParentId=${encodeURIComponent(spSeries.Id)}&IncludeItemTypes=Episode&Recursive=true&EnableUserData=true`);
          recordItems((epsFallback && epsFallback.Items) || []);
        }
      }

      // 2. Fallback if no series matched or 0 episodes returned
      if (Object.keys(epMap).length === 0) {
        const epsRes = await jfFetch(`/Items?${userParam}IncludeItemTypes=Episode&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}&Limit=500&EnableUserData=true`);
        const items = ((epsRes && epsRes.Items) || []).filter(it =>
          !it.SeriesName || it.SeriesName.toLowerCase().includes('south park')
        );
        recordItems(items);
      }
    } catch (err) {
      console.warn('Jellyfin episode sync warning:', err);
    }

    jfConfig.episodeMap = epMap;
    jfConfig.lastSyncCount = watchedCount;
    saveJson(STORAGE_KEY_JF, jfConfig);
    notifyWatchedListeners(epMap);
    return epMap;
  }

  // Push local Watched toggle (true/false) to Jellyfin Server
  // Supports both Jellyfin 10.9-12.x `/UserPlayedItems/{itemId}?userId=...` and `/Users/{userId}/PlayedItems/{itemId}`
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
      const method = isWatched ? 'POST' : 'DELETE';

      try {
        // Modern Jellyfin 10.9 - 12.x endpoint
        await jfFetch(`/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(jfConfig.userId)}`, { method });
      } catch (_) {
        // Classic endpoint fallback
        await jfFetch(`/Users/${encodeURIComponent(jfConfig.userId)}/PlayedItems/${encodeURIComponent(itemId)}`, { method });
      }

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
    const userParam = jfConfig.userId ? `userId=${encodeURIComponent(jfConfig.userId)}&` : '';
    const searchRes = await jfFetch(`/Items?${userParam}IncludeItemTypes=Episode&Recursive=true&SearchTerm=${encodeURIComponent(ep.title)}&Limit=20&EnableUserData=true`);
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
