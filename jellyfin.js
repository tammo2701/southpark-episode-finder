// Settings & Jellyfin Cast Integration for South Park Episode Finder
(function () {
  const STORAGE_KEY_JF = 'sp_jellyfin_cfg';
  const STORAGE_KEY_PREFS = 'sp_user_prefs';

  // Unique persistent DeviceId for Jellyfin X-Emby-Authorization header
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
    episodeMap: {} // "S8E7" -> { id, name }
  });

  const userPrefs = loadJson(STORAGE_KEY_PREFS, {
    langMode: localStorage.getItem('sp_lang_mode') || 'auto', // 'auto' | 'de' | 'en'
    defaultRole: 'main', // 'main' | 'all'
    showDualLang: true,
    pageSize: 60
  });

  let activeSessions = [];

  function cleanServerUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  function buildEmbyAuthHeader(token) {
    const devId = getDeviceId();
    let hdr = `MediaBrowser Client="South Park Episode Finder", Device="Web App", DeviceId="${devId}", Version="1.0.0"`;
    if (token) {
      hdr += `, Token="${token}"`;
    }
    return hdr;
  }

  // Direct fetch to Jellyfin (for LAN / local network) with fallback to server CORS proxy
  async function jfFetch(path, options = {}) {
    const base = cleanServerUrl(jfConfig.serverUrl);
    if (!base) throw new Error('Server URL missing');
    const url = `${base}${path.startsWith('/') ? path : '/' + path}`;
    const method = options.method || 'GET';
    const token = options.token !== undefined ? options.token : jfConfig.accessToken;

    const headers = {
      'Accept': 'application/json',
      'X-Emby-Authorization': buildEmbyAuthHeader(token),
      ...(options.headers || {})
    };
    if (token) {
      headers['X-Emby-Token'] = token;
    }
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOpts = {
      method,
      headers,
      body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
    };

    try {
      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (directErr) {
      // Check if Mixed Content (HTTPS page calling HTTP local IP)
      if (window.location.protocol === 'https:' && url.startsWith('http://')) {
        // Try proxy in case it's a reachable host, otherwise explain Mixed Content clearly
        try {
          const proxyRes = await fetch('/api/jellyfin-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, method, headers, body: options.body })
          });
          if (proxyRes.ok) {
            const t = await proxyRes.text();
            return t ? JSON.parse(t) : {};
          }
        } catch (_) {}
        const mixedMsg = document.documentElement.lang === 'de'
          ? 'Browser blockiert unverschlüsselte HTTP-Verbindung (Mixed Content) von einer HTTPS-Seite. Nutze HTTPS für Jellyfin oder erlaube „Unsichere Inhalte“ in den Website-Einstellungen deines Browsers.'
          : 'Browser blocked HTTP connection (Mixed Content) from an HTTPS page. Use HTTPS for Jellyfin or allow "Insecure content" in your browser site settings for this page.';
        throw new Error(mixedMsg);
      }
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
        throw new Error('Authentication failed');
      }
      jfConfig.accessToken = authData.AccessToken;
      jfConfig.userId = authData.User ? authData.User.Id : '';
    } else {
      const apiKey = (params.apiKey || '').trim();
      if (!apiKey) {
        throw new Error(document.documentElement.lang === 'de' ? 'Bitte API-Key / Token eingeben.' : 'Please enter an API Key / Token.');
      }
      jfConfig.accessToken = apiKey;
      // Fetch users to get first active user ID
      const users = await jfFetch('/Users', { token: apiKey });
      if (Array.isArray(users) && users.length > 0) {
        const matchUser = jfConfig.username
          ? users.find(u => (u.Name || '').toLowerCase() === jfConfig.username.toLowerCase()) || users[0]
          : users[0];
        jfConfig.userId = matchUser.Id;
        jfConfig.username = matchUser.Name || jfConfig.username;
      }
    }

    // 3. Search for South Park Series & Episodes in Jellyfin library
    await syncSouthParkEpisodes();

    // 4. Fetch available TV / Cast Sessions
    await refreshSessions();

    jfConfig.connected = true;
    saveJson(STORAGE_KEY_JF, jfConfig);
    return jfConfig;
  }

  async function syncSouthParkEpisodes() {
    const epMap = {};
    try {
      const userPath = jfConfig.userId ? `/Users/${jfConfig.userId}/Items` : '/Items';
      const seriesRes = await jfFetch(`${userPath}?IncludeItemTypes=Series&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}`);
      const seriesList = (seriesRes && seriesRes.Items) || [];
      const spSeries = seriesList.find(s => (s.Name || '').toLowerCase().includes('south park')) || seriesList[0];

      if (spSeries && spSeries.Id) {
        jfConfig.seriesId = spSeries.Id;
        const epsRes = await jfFetch(`/Shows/${spSeries.Id}/Episodes? fields=Overview` + (jfConfig.userId ? `&UserId=${jfConfig.userId}` : ''));
        const items = (epsRes && epsRes.Items) || [];
        for (const item of items) {
          const s = item.ParentIndexNumber !== undefined ? item.ParentIndexNumber : -1;
          const e = item.IndexNumber !== undefined ? item.IndexNumber : -1;
          if (s >= 0 && e >= 0) {
            epMap[`S${s}E${e}`] = { id: item.Id, name: item.Name || '' };
          }
        }
      } else {
        // Fallback: search all Episode items matching South Park
        const epsRes = await jfFetch(`${userPath}?IncludeItemTypes=Episode&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}&Limit=500`);
        const items = (epsRes && epsRes.Items) || [];
        for (const item of items) {
          if ((item.SeriesName || '').toLowerCase().includes('south park')) {
            const s = item.ParentIndexNumber !== undefined ? item.ParentIndexNumber : -1;
            const e = item.IndexNumber !== undefined ? item.IndexNumber : -1;
            if (s >= 0 && e >= 0) {
              epMap[`S${s}E${e}`] = { id: item.Id, name: item.Name || '' };
            }
          }
        }
      }
    } catch (_) {}
    jfConfig.episodeMap = epMap;
    saveJson(STORAGE_KEY_JF, jfConfig);
    return epMap;
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
    // Filter for sessions that are active and aren't this browser tab itself (prefer SupportsRemoteControl)
    const remoteCapable = list.filter(s => s.DeviceId !== myDevId && s.SupportsRemoteControl !== false);
    activeSessions = remoteCapable.length > 0 ? remoteCapable : list.filter(s => s.DeviceId !== myDevId);

    // Keep or auto-select first TV session
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
    // Live search fallback by Episode Title or Season/Episode
    const userPath = jfConfig.userId ? `/Users/${jfConfig.userId}/Items` : '/Items';
    const searchRes = await jfFetch(`${userPath}?IncludeItemTypes=Episode&Recursive=true&SearchTerm=${encodeURIComponent(ep.title)}&Limit=20`);
    const items = (searchRes && searchRes.Items) || [];
    const exact = items.find(it =>
      (it.ParentIndexNumber === ep.s && it.IndexNumber === ep.e) ||
      (it.Name || '').toLowerCase() === ep.title.toLowerCase()
    ) || items[0];

    if (exact && exact.Id) {
      jfConfig.episodeMap[key] = { id: exact.Id, name: exact.Name || ep.title };
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
        ? 'Kein Ziel-TV ausgewählt. Bitte öffne die Jellyfin-App auf deinem TV und klicke auf „TVs aktualisieren“.'
        : 'No target TV selected. Please open the Jellyfin app on your TV and click "Refresh TVs".');
    }

    const itemId = await resolveEpisodeItemId(ep);
    if (!itemId) {
      throw new Error(isDe
        ? `Folge S${ep.s}E${ep.e} („${ep.title}“) wurde in deiner Jellyfin-Mediathek nicht gefunden.`
        : `Episode S${ep.s}E${ep.e} ("${ep.title}") was not found in your Jellyfin library.`);
    }

    await jfFetch(`/Sessions/${ encodeURIComponent(targetSessionId) }/Playing?ItemIds=${ encodeURIComponent(itemId) }&PlayCommand=PlayNow`, {
      method: 'POST'
    });

    return { itemId, sessionId: targetSessionId };
  }

  // Remote control commands (PlayPause, Stop, Mute, Unmute)
  async function sendRemoteCommand(command, sessionIdOverride) {
    const targetSessionId = sessionIdOverride || jfConfig.selectedSessionId;
    if (!targetSessionId) return;
    await jfFetch(`/Sessions/${ encodeURIComponent(targetSessionId) }/Playing/${ encodeURIComponent(command) }`, {
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
    refreshSessions,
    getActiveSessions: () => activeSessions,
    resolveEpisodeItemId,
    castEpisodeToTv,
    sendRemoteCommand,
    disconnectJellyfin
  };
})();
