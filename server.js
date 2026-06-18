const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INDEX_PATH = path.join(__dirname, 'index.html');
const OG_IMAGE_PATH = path.join(__dirname, 'og-image.svg');

// Only ParthMuley's own repos can be requested through the GitHub context
// proxy below, so this can't be abused as an open proxy for arbitrary repos.
const ALLOWED_REPO_PATTERN = /^ParthMuley\/[A-Za-z0-9_.-]+$/;

// GitHub's unauthenticated API is rate-limited per source IP, shared across
// every visitor hitting this server, so repo context is cached here instead
// of being re-fetched by every browser on every click.
const GITHUB_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const githubContextCache = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitStore = new Map();

// Gemini's free tier shares one quota across every visitor (confirmed via
// the API's own quota error: 5 RPM for gemini-2.5-flash), so this caps total
// upstream calls per minute below that, regardless of how many distinct IPs
// are hitting /api/gemini.
const GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const GLOBAL_RATE_LIMIT_MAX_REQUESTS = 4;
let globalRateState = { windowStart: 0, count: 0 };

// Responses are cached per prompt so repeat clicks (same project + button,
// from anyone) don't re-spend the shared free-tier quota.
const RESPONSE_CACHE_TTL_MS = 60 * 60 * 1000;
const responseCache = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const existing = rateLimitStore.get(ip);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  existing.count += 1;
  return false;
}

function isGlobalRateLimited() {
  const now = Date.now();
  if (now - globalRateState.windowStart > GLOBAL_RATE_LIMIT_WINDOW_MS) {
    globalRateState = { windowStart: now, count: 0 };
  }
  return globalRateState.count >= GLOBAL_RATE_LIMIT_MAX_REQUESTS;
}

function recordGlobalRequest() {
  globalRateState.count += 1;
}

function getCacheKey(promptText) {
  return crypto.createHash('sha256').update(promptText).digest('hex');
}

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return entry.body;
}

function setCachedResponse(key, body) {
  responseCache.set(key, { body, timestamp: Date.now() });
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  const MAX_BYTES = 20 * 1024;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BYTES) {
      throw new Error('Payload too large');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body);
}

async function handleGeminiProxy(req, res) {
  if (!GEMINI_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing GEMINI_API_KEY on server' }));
    return;
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    return;
  }

  try {
    const payload = await readJsonBody(req);
    const promptText = payload?.contents?.[0]?.parts?.[0]?.text || '';
    if (!promptText || promptText.length > 8000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid prompt input' }));
      return;
    }

    const cacheKey = getCacheKey(promptText);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(cached);
      return;
    }

    if (isGlobalRateLimited()) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Navigator is recharging, try again shortly' }));
      return;
    }
    recordGlobalRequest();

    const geminiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await geminiResponse.text();
    if (geminiResponse.ok) {
      setCachedResponse(cacheKey, responseText);
    }
    res.writeHead(geminiResponse.status, { 'Content-Type': 'application/json' });
    res.end(responseText);
  } catch (error) {
    let status = 400;
    let message = 'Invalid request payload';

    if (error.message === 'Payload too large') {
      status = 413;
      message = 'Payload too large';
    } else if (error instanceof SyntaxError) {
      message = 'Invalid JSON format';
    } else if (error.name === 'TypeError') {
      status = 502;
      message = 'Failed to reach Gemini service';
    }

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

async function fetchGithubContext(repo) {
  const [repoRes, readmeRes, langRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}`),
    fetch(`https://api.github.com/repos/${repo}/readme`),
    fetch(`https://api.github.com/repos/${repo}/languages`),
  ]);

  let context = '';
  if (repoRes.ok) {
    const data = await repoRes.json();
    if (data.description) context += `Repo description: ${data.description}\n`;
  }
  if (langRes.ok) {
    const langData = await langRes.json();
    const languages = Object.keys(langData);
    if (languages.length) context += `Languages used: ${languages.join(', ')}\n`;
  }
  if (readmeRes.ok) {
    const readmeData = await readmeRes.json();
    const decoded = Buffer.from(readmeData.content.trim(), 'base64').toString('utf8');
    context += `README (first 1200 chars): ${decoded.slice(0, 1200)}`;
  }
  return context;
}

async function handleGithubContextProxy(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const repo = url.searchParams.get('repo') || '';

  if (!ALLOWED_REPO_PATTERN.test(repo)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown or invalid repo' }));
    return;
  }

  const cached = githubContextCache.get(repo);
  if (cached && Date.now() - cached.timestamp < GITHUB_CONTEXT_CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context: cached.context }));
    return;
  }

  try {
    const context = await fetchGithubContext(repo);
    githubContextCache.set(repo, { context, timestamp: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context }));
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to reach GitHub' }));
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/gemini') {
    await handleGeminiProxy(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/github-context')) {
    await handleGithubContextProxy(req, res);
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Unable to load index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/og-image.svg') {
    fs.readFile(OG_IMAGE_PATH, 'utf8', (err, svg) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Portfolio server running on http://localhost:${PORT}`);
});
