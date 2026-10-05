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

    // Attempt 2: Query parameter `?ApiKey=...` without custom headers
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

    // Attempt 3: Both `Authorization` and `X-Emby-Authorization`
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

  // Helper: Resolve the best User ID for reading Watched/Played status
  // When using an API key without a username specified, picks the user matching username OR the user who actually has watched episodes.
  async function resolveBestUserId() {
    // 1. Try /Users/Me (works for user session tokens from AuthenticateByName)
    try {
      const me = await jfFetch('/Users/Me');
      if (me && me.Id) {
        jfConfig.userId = me.Id;
        if (me.Name) jfConfig.username = me.Name;
        return me.Id;
      }
    } catch (_) {}

    // 2. Fetch all users via /Users
    try {
      const users = await jfFetch('/Users');
      if (Array.isArray(users) && users.length > 0) {
        if (jfConfig.username) {
          const byName = users.find(u => (u.Name || '').toLowerCase() === jfConfig.username.toLowerCase());
          if (byName && byName.Id) {
            jfConfig.userId = byName.Id;
            return byName.Id;
          }
        }
        // Sort users by most recently active (LastActivityDate) so we pick the real main viewer account
        const sorted = [...users].sort((a, b) => {
          const tA = a.LastActivityDate ? new Date(a.LastActivityDate).getTime() : 0;
          const tB = b.LastActivityDate ? new Date(b.LastActivityDate).getTime() : 0;
          return tB - tA;
        });
        jfConfig.userId = sorted[0].Id;
        if (!jfConfig.username && sorted[0].Name) {
          jfConfig.username = sorted[0].Name;
        }
        return sorted[0].Id;
      }
    } catch (_) {}

    return jfConfig.userId || '';
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
      await resolveBestUserId();
    }

    // 3. Scan South Park Series, Episodes & Played/Watched status in Jellyfin library
    await syncSouthParkEpisodes();

    // 4. Fetch available active TV / Cast Sessions
    await refreshSessions().catch(() => []);

    jfConfig.connected = true;
    saveJson(STORAGE_KEY_JF, jfConfig);
    return jfConfig;
  }

  // Extract Season & Episode key ("S1E1") from Jellyfin item
  function extractSeKey(item) {
    let s = item.ParentIndexNumber !== undefined && item.ParentIndexNumber !== null ? Number(item.ParentIndexNumber) : -1;
    let e = item.IndexNumber !== undefined && item.IndexNumber !== null ? Number(item.IndexNumber) : -1;
    if (s >= 0 && e >= 0) {
      return `S${s}E${e}`;
    }
    // Fallback: parse from Name or Path if SxxExx is present
    const str = `${item.Name || ''} ${item.Path || ''}`;
    const m = str.match(/[sS](\d{1,2})\s*[eExX](\d{1,2})/);
    if (m) {
      return `S${parseInt(m[1], 10)}E${parseInt(m[2], 10)}`;
    }
    return null;
  }

  // Fetches all South Park episodes + accurately syncs Played/Watched episodes from Jellyfin
  // Uses BOTH UserData inspection AND explicit `Filters=IsPlayed` / `IsPlayed=true` query so watched count is 100% accurate across all Jellyfin versions!
  async function syncSouthParkEpisodes() {
    const epMap = {};

    if (!jfConfig.serverUrl || !jfConfig.accessToken) {
      return epMap;
    }

    if (!jfConfig.userId) {
      await resolveBestUserId();
    }

    const uid = jfConfig.userId;
    const userScopedItemsPath = uid ? `/Users/${encodeURIComponent(uid)}/Items` : '/Items';
    const userQuery = uid ? `UserId=${encodeURIComponent(uid)}&userId=${encodeURIComponent(uid)}&` : '';

    const recordItems = (items, forcePlayed = false) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const key = extractSeKey(item);
        if (!key) continue;
        const prev = epMap[key] || {};
        const ud = item.UserData || {};
        const played = Boolean(
          forcePlayed ||
          prev.played ||
          ud.Played === true ||
          (typeof ud.PlayCount === 'number' && ud.PlayCount > 0)
        );
        const fav = Boolean(prev.fav || ud.IsFavorite === true);
        epMap[key] = {
          id: item.Id || prev.id,
          name: item.Name || prev.name || '',
          played,
          fav
        };
      }
    };

    try {
      // 1. Find South Park Series ID
      const seriesRes = await jfFetch(`${userScopedItemsPath}?${userQuery}IncludeItemTypes=Series&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}`);
      const seriesList = (seriesRes && seriesRes.Items) || [];
      const spSeries = seriesList.find(s => (s.Name || '').toLowerCase().includes('south park')) || seriesList[0];

      if (spSeries && spSeries.Id) {
        jfConfig.seriesId = spSeries.Id;

        // 2A. Fetch all episodes of South Park via User-scoped /Items with ParentId (reliably includes UserData in Jellyfin 10.8 -> 12.x)
        try {
          const allEpsRes = await jfFetch(`${userScopedItemsPath}?${userQuery}ParentId=${encodeURIComponent(spSeries.Id)}&IncludeItemTypes=Episode&Recursive=true&EnableUserData=true&Limit=1000`);
          recordItems((allEpsRes && allEpsRes.Items) || [], false);
        } catch (_) {}

        // 2B. Also fetch via /Shows/{seriesId}/Episodes if needed
        if (Object.keys(epMap).length === 0) {
          try {
            const showsRes = await jfFetch(`/Shows/${encodeURIComponent(spSeries.Id)}/Episodes?${userQuery}EnableUserData=true&Limit=1000`);
            recordItems((showsRes && showsRes.Items) || [], false);
          } catch (_) {}
        }

        // 3. Explicit Watched Query (`IsPlayed=true` & `Filters=IsPlayed`) for this Series!
        // This guarantees that even if Jellyfin omits UserData on bulk /Shows responses, every watched episode is 100% marked as played.
        try {
          const playedRes = await jfFetch(`${userScopedItemsPath}?${userQuery}ParentId=${encodeURIComponent(spSeries.Id)}&IncludeItemTypes=Episode&Recursive=true&IsPlayed=true&Filters=IsPlayed&Limit=1000`);
          recordItems((playedRes && playedRes.Items) || [], true);
        } catch (_) {}
      }

      // 4. Fallback if Series wasn't found via ParentId
      if (Object.keys(epMap).length === 0) {
        const epsRes = await jfFetch(`${userScopedItemsPath}?${userQuery}IncludeItemTypes=Episode&Recursive=true&SearchTerm=${encodeURIComponent('South Park')}&EnableUserData=true&Limit=1000`);
        const items = ((epsRes && epsRes.Items) || []).filter(it =>
          !it.SeriesName || it.SeriesName.toLowerCase().includes('south park')
        );
        recordItems(items, false);
      }

      // 5. If still 0 watched found AND we authenticated via API Key (where multiple users might exist on the server),
      // check if another user profile on the server has the watched South Park episodes!
      const currentWatchedCount = Object.values(epMap).filter(x => x.played).length;
      if (currentWatchedCount === 0 && jfConfig.authMode === 'apikey' && jfConfig.seriesId) {
        try {
          const allUsers = await jfFetch('/Users');
          if (Array.isArray(allUsers) && allUsers.length > 1) {
            for (const u of allUsers) {
              if (!u || !u.Id || u.Id === jfConfig.userId) continue;
              const uPlayed = await jfFetch(`/Users/${encodeURIComponent(u.Id)}/Items?UserId=${encodeURIComponent(u.Id)}&ParentId=${encodeURIComponent(jfConfig.seriesId)}&IncludeItemTypes=Episode&Recursive=true&IsPlayed=true&Filters=IsPlayed&Limit=1000`);
              const pItems = (uPlayed && uPlayed.Items) || [];
              if (pItems.length > 0) {
                jfConfig.userId = u.Id;
                if (u.Name) jfConfig.username = u.Name;
                recordItems(pItems, true);
                break;
              }
            }
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('Jellyfin episode sync warning:', err);
    }

    const totalWatched = Object.values(epMap).filter(x => x.played).length;
    jfConfig.episodeMap = epMap;
    jfConfig.lastSyncCount = totalWatched;
    saveJson(STORAGE_KEY_JF, jfConfig);
    notifyWatchedListeners(epMap);
    return epMap;
  }

  // Push local Watched toggle (true/false) to Jellyfin Server
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
        await jfFetch(`/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(jfConfig.userId)}`, { method });
      } catch (_) {
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

  // Strictly filter /Sessions so ONLY online, video-capable players (TVs, Media Players) are shown —
  // excluding Home Assistant, bots, scrapers, and powered-off TVs!
  function isRealActiveVideoPlayerSession(s, myDevId) {
    if (!s || s.DeviceId === myDevId) return false;

    // 1. Exclude non-player integrations / bots (Home Assistant, Jellyseerr, Sonarr, Radarr, etc.)
    const clientStr = `${s.Client || ''} ${s.DeviceName || ''} ${s.ApplicationVersion || ''}`.toLowerCase();
    const blockedKeywords = [
      'home assistant',
      'home-assistant',
      'homeassistant',
      'hass',
      'jellyseerr',
      'overseerr',
      'sonarr',
      'radarr',
      'prowlarr',
      'bazarr',
      'tautulli',
      'jellystat',
      'webhook',
      'python',
      'curl',
      'episode finder'
    ];
    if (blockedKeywords.some(kw => clientStr.includes(kw))) {
      return false;
    }

    // 2. Must be currently active on the server
    if (s.IsActive === false) return false;

    // 3. Must support media/remote control AND Video playback (or PlayMediaSource command)
    if (s.SupportsMediaControl === false && s.SupportsRemoteControl === false) {
      return false;
    }

    const playable = Array.isArray(s.PlayableMediaTypes) ? s.PlayableMediaTypes.map(x => String(x).toLowerCase()) : [];
    const commands = Array.isArray(s.SupportedCommands) ? s.SupportedCommands.map(x => String(x).toLowerCase()) : [];
    const canPlayVideo = playable.includes('video') || commands.includes('playmediasource') || commands.includes('play');
    if (!canPlayVideo) {
      return false;
    }

    // 4. Filter out stale / powered-off TVs:
    // Jellyfin keeps closed TV sessions in /Sessions for hours unless we check LastActivityDate or NowPlayingItem.
    // Active clients send heartbeats or WebSocket pings every few seconds/minutes.
    if (s.NowPlayingItem) {
      return true; // Currently playing media right now -> definitely on!
    }
    if (s.LastActivityDate) {
      const lastMs = new Date(s.LastActivityDate).getTime();
      if (!isNaN(lastMs)) {
        const ageMinutes = (Date.now() - lastMs) / 60000;
        // If a device hasn't communicated with Jellyfin in over 10 minutes and isn't playing anything, the TV/app is off
        if (ageMinutes > 10) {
          return false;
        }
      }
    }

    return true;
  }

  async function refreshSessions() {
    if (!jfConfig.serverUrl || !jfConfig.accessToken) {
      activeSessions = [];
      return [];
    }
    // Query /Sessions with ControllableByUserId if available so Jellyfin pre-filters controllable sessions
    const query = jfConfig.userId ? `?ControllableByUserId=${encodeURIComponent(jfConfig.userId)}` : '';
    let list = [];
    try {
      list = await jfFetch(`/Sessions${query}`);
    } catch (_) {
      list = await jfFetch('/Sessions');
    }

    if (!Array.isArray(list)) {
      activeSessions = [];
      return [];
    }

    const myDevId = getDeviceId();
    activeSessions = list.filter(s => isRealActiveVideoPlayerSession(s, myDevId));

    // Sort: currently playing devices first, then TVs / Android TV / WebOS / Tizen / Kodi, then most recent activity
    activeSessions.sort((a, b) => {
      if (Boolean(a.NowPlayingItem) !== Boolean(b.NowPlayingItem)) {
        return a.NowPlayingItem ? -1 : 1;
      }
      const tA = a.LastActivityDate ? new Date(a.LastActivityDate).getTime() : 0;
      const tB = b.LastActivityDate ? new Date(b.LastActivityDate).getTime() : 0;
      return tB - tA;
    });

    if (activeSessions.length > 0) {
      const stillExists = activeSessions.find(s => s.Id === jfConfig.selectedSessionId);
      if (!stillExists) {
        jfConfig.selectedSessionId = activeSessions[0].Id;
        jfConfig.selectedDeviceName = `${activeSessions[0].DeviceName || activeSessions[0].Client || 'TV'} (${activeSessions[0].Client || 'Jellyfin'})`;
        saveJson(STORAGE_KEY_JF, jfConfig);
      }
    } else {
      jfConfig.selectedSessionId = '';
      jfConfig.selectedDeviceName = '';
      saveJson(STORAGE_KEY_JF, jfConfig);
    }
    return activeSessions;
  }

  async function resolveEpisodeItemId(ep) {
    const key = `S${ep.s}E${ep.e}`;
    if (jfConfig.episodeMap && jfConfig.episodeMap[key] && jfConfig.episodeMap[key].id) {
      return jfConfig.episodeMap[key].id;
    }
    const userParam = jfConfig.userId ? `UserId=${encodeURIComponent(jfConfig.userId)}&` : '';
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
        ? 'Kein eingeschalteter TV/Player gefunden. Bitte öffne die Jellyfin-App auf deinem TV und klicke auf „TVs suchen“.'
        : 'No active TV/player found. Please open the Jellyfin app on your TV and click "Scan TVs".');
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
