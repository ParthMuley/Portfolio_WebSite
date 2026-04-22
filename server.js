const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INDEX_PATH = path.join(__dirname, 'index.html');

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitStore = new Map();

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

    const geminiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await geminiResponse.text();
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/gemini') {
    await handleGeminiProxy(req, res);
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

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Portfolio server running on http://localhost:${PORT}`);
});
