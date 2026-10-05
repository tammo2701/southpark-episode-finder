// Settings, Jellyfin Cast & Two-Way Watched Sync for South Park Episode Finder
(function () {
  const STORAGE_KEY_JF = 'sp_jellyfin_cfg';
  const STORAGE_KEY_PREFS = 'sp_user_prefs';

  // Unique persistent DeviceId for Jellyfin authentication
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

  // Normalize URL: auto-prepend http:// if missing, strip trailing slashes and /web/index.html
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

  // Append api_key or Emby auth query parameters so GET and POST without custom headers work CORS-preflight-free!
  function appendTokenToUrl(rawUrl, token) {
    if (!token) return rawUrl;
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}api_key=${encodeURIComponent(token)}`;
  }

  // Smart Jellyfin Fetch:
  // 1. For GET or headerless POSTs, avoids non-simple custom headers first so Jellyfin servers without preflight setup still respond.
  // 2. Falls back to full X-Emby-Authorization header fetch.
  // 3. Falls back to backend proxy if reachable.
  // 4. Produces accurate, non-misleading diagnostics on failure.
  async function jfFetch(path, options = {}) {
    const base = cleanServerUrl(jfConfig.serverUrl);
    if (!base) throw new Error('Server URL missing');
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    const method = (options.method || 'GET').toUpperCase();
    const token = options.token !== undefined ? options.token : jfConfig.accessToken;
    const rawUrl = `${base}${cleanPath}`;
    const urlWithToken = appendTokenToUrl(rawUrl, token);

    // Attempt 1: Simple CORS request (no custom X-Emby-* headers that trigger OPTIONS preflight)
    // Works for all GET requests, /Users/AuthenticateByName (with text/plain JSON or X-Emby-Authorization), and POST commands with query params
    if (!options.forceCustomHeaders) {
      try {
        const simpleHeaders = {};
        let targetUrl = urlWithToken;

        if (cleanPath.includes('/Users/AuthenticateByName')) {
          // AuthenticateByName requires Authorization or X-Emby-Authorization
          simpleHeaders['X-Emby-Authorization'] = buildEmbyAuthHeader('');
          simpleHeaders['Content-Type'] = 'application/json';
          targetUrl = rawUrl;
        } else if (options.body) {
          simpleHeaders['Content-Type'] = 'application/json';
        }

        const res = await fetch(targetUrl, {
          method,
          headers: simpleHeaders,
          body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
        });

        if (res.ok) {
          const text = await res.text();
          return text ? JSON.parse(text) : {};
        }
        if (res.status === 401 || res.status === 403) {
          const isDe = document.documentElement.lang === 'de';
          throw new Error(isDe
            ? `Anmeldung fehlgeschlagen (HTTP ${res.status}): Bitte Benutzername/Passwort oder API-Key prüfen.`
            : `Authentication failed (HTTP ${res.status}): Please check your username/password or API key.`);
        }
      } catch (err1) {
        if (err1 && err1.message && (err1.message.includes('401') || err1.message.includes('403'))) {
          throw err1;
        }
        // Otherwise proceed to Attempt 2
      }
    }

    // Attempt 2: Full X-Emby-Authorization & X-Emby-Token headers
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
        const errText = await res2.text().catch(() => '');
        throw new Error(`HTTP ${res2.status}: ${errText || res2.statusText}`);
      }
      const text2 = await res2.text();
      return text2 ? JSON.parse(text2) : {};
    } catch (directErr) {
      // Attempt 3: Server-side proxy (works if running locally via node server.js or public domain)
      try {
        const proxyRes = await fetch('/api/jellyfin-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlWithToken, method, headers: fullHeaders, body: options.body })
        });
        if (proxyRes.ok) {
          const t = await proxyRes.text();
          return t ? JSON.parse(t) : {};
        }
      } catch (_) {}

      const isDe = document.documentElement.lang === 'de';
      const pageIsHttps = window.location.protocol === 'https:';
      const targetIsHttp = rawUrl.toLowerCase().startsWith('http://');

      if (pageIsHttps && targetIsHttp) {
        throw new Error(isDe
          ? `Verbindung zu ${base} wurde vom Browser blockiert, weil diese App aktuell über HTTPS (${window.location.origin}) geöffnet ist, dein Jellyfin aber über unverschlüsseltes HTTP läuft (oder im lokalen Netzwerk nicht erreichbar ist). Tipp: Erlaube in den Browser-Website-Einstellungen für diese Seite „Unsichere Inhalte / Lokales Netzwerk“ oder öffne die App lokal über HTTP.`
          : `Connection to ${base} was blocked by the browser because this app is loaded over HTTPS (${window.location.origin}) while your Jellyfin server uses HTTP (or is unreachable). Tip: Allow "Insecure content / Local network" in your browser site settings or run the app locally over HTTP.`);
      }

      throw new Error(isDe
        ? `Jellyfin-Server unter „${base}“ nicht erreichbar (${directErr.message || 'Netzwerkfehler'}). Bitte prüfe, ob IP & Port (z.B. :8096) stimmen und du im selben WLAN/Netzwerk bist.`
        : `Could not reach Jellyfin server at "${base}" (${directErr.message || 'Network error'}). Please verify the IP & port (e.g. :8096) and that you are on the same network.`);
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

    // 1. Public server info check
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

    // Ensure we have a valid userId so Jellyfin returns UserData (Played status)
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

      // Also search Episode items directly in case Specials or loose episodes are stored separately
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

  // Find Jellyfin ItemId for a given South Park episode { s, e, title }
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

  // Cast / Play Episode on Selected Jellyfin TV Session
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

  // Remote control commands (PlayPause, Stop, Mute, Unmute)
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
