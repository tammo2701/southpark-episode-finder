const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Optional CORS proxy for reachable Jellyfin instances
app.post('/api/jellyfin-proxy', async (req, res) => {
  try {
    const { url, method = 'GET', headers = {}, body } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Invalid target URL' });
    }
    const fetchOpts = {
      method,
      headers: { ...headers }
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.send(text);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Proxy request failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
