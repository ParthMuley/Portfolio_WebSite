# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page portfolio site with zero build step: `index.html` is the entire frontend (HTML + Tailwind via CDN + vanilla JS in an inline `<script>`), and `server.js` is a minimal Node `http` server that serves that file and proxies AI requests to Gemini.

## Commands

- Run locally: `node server.js` (or `npm start`). Serves on `http://localhost:3000` (override with `PORT` env var).
- Requires `GEMINI_API_KEY` env var for the `/api/gemini` proxy to work; without it the endpoint returns a 500 but the static site still loads.
- No build, lint, test, or package manager dependencies — `package.json` has no `dependencies` and no test/lint scripts.
- Deployment is via Render (`render.yaml`): `node server.js` as the start command, `GEMINI_API_KEY` set as a secret env var in the Render dashboard (not in the repo).

## Architecture

**`server.js`** — plain Node `http` server, no framework/dependencies:
- `GET /` or `/index.html` → serves `index.html`.
- `POST /api/gemini` → proxies to `https://generativelanguage.googleapis.com/.../gemini-1.5-flash:generateContent`, injecting `GEMINI_API_KEY` server-side so the key never reaches the client.
- Has its own in-memory IP-based rate limiter (`rateLimitStore`, 20 req/min/IP) and a request body size cap (20 KB) — both implemented manually, not via middleware.
- Anything else → 404.

**`index.html`** — everything else lives here:
- Panel-based nav (ABOUT / JOURNEY / PROJECTS / SKILLS / CONTACT) toggled by adding/removing `.active` on `.nav-item` / `.content-panel` elements; transitions are CSS clip-path keyframes, not a JS framework.
- `projectsData` (inline JS object, ~line 272) is the single source of truth for portfolio project content (name, type, optional `githubRepo`, description). Add/edit projects here directly.
- Selecting a project with a `githubRepo` fetches live repo data from the public GitHub API (`api.github.com/repos/...` and its `/readme`) client-side to enrich the project panel.
- "AI NAVIGATOR" section (per-project, templated from `#ai-section-template`) sends a prompt built from project + GitHub data to `GEMINI_API_URL`, which defaults to same-origin `/api/gemini` (i.e., the proxy in `server.js`) but can be overridden via a `?apiUrl=` query param for testing against a different backend.
- All client-side Gemini error handling assumes the proxy's JSON error shape (`{ error: message }`); keep `server.js` error responses in that shape if you change them.

## Conventions

- Keep the Gemini API key server-side only — never call the Gemini API directly from `index.html`.
- This is intentionally dependency-free; avoid introducing npm packages or a bundler unless there's a strong reason, since the deploy story (Render, `node server.js`) assumes none.
