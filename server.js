'use strict';

/**
 * FHIR Patient Manager — backend
 * ----------------------------------
 * 1. Serves the static frontend (public/).
 * 2. Acts as a FHIR proxy: every /api/fhir/* request is forwarded to the
 *    real FHIR R4 server with the `Authorization: Bearer <token>` header
 *    injected from .env. The bearer token never leaves this process.
 *
 * Run:  npm start   (or:  node server.js)
 */

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// ── Configuration (from .env) ──────────────────────────────────────────────
const FHIR_BASE_URL = (process.env.FHIR_BASE_URL || '').trim().replace(/\/+$/, '');
const FHIR_BEARER_TOKEN = (process.env.FHIR_BEARER_TOKEN || '').trim();
const PORT = Number(process.env.PORT) || 3000;
const PROXY_PREFIX = '/api/fhir';
const UPSTREAM_TIMEOUT_MS = 30000;

if (!FHIR_BASE_URL) {
  console.error('[patient-manager] FHIR_BASE_URL is not set.');
  console.error('[patient-manager] Copy .env.example to .env and set FHIR_BASE_URL (and FHIR_BEARER_TOKEN if required), then restart.');
  process.exit(1);
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

// Accept standard JSON and FHIR JSON content types.
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/fhir+json'] }));

// Tiny request logger.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ── Safe, token-free config endpoint (for the UI's connection pill) ───────
app.get('/api/config', (req, res) => {
  let host = FHIR_BASE_URL;
  let pathPart = '';
  try {
    const u = new URL(FHIR_BASE_URL);
    host = u.host;
    pathPart = u.pathname;
  } catch {
    /* keep raw string */
  }
  res.json({ fhirServer: host, fhirPath: pathPart, auth: Boolean(FHIR_BEARER_TOKEN) });
});

// ── FHIR proxy: /api/fhir/<everything> -> <FHIR_BASE_URL>/<everything> ─────
app.all(`${PROXY_PREFIX}/*`, async (req, res) => {
  const upstreamPath = req.path.slice(PROXY_PREFIX.length) || '/';
  let target = FHIR_BASE_URL + upstreamPath;

  // Forward the browser's query string verbatim (search params, _count, ...).
  const queryIndex = req.originalUrl.indexOf('?');
  if (queryIndex !== -1) target += req.originalUrl.slice(queryIndex);

  // Ask the server for JSON explicitly (skip if the query already has _format).
  if (!target.includes('_format=')) {
    target += (target.includes('?') ? '&' : '?') + '_format=json';
  }

  const headers = {
    Accept: 'application/fhir+json, application/json',
    'Content-Type': 'application/fhir+json',
  };
  if (FHIR_BEARER_TOKEN) headers.Authorization = `Bearer ${FHIR_BEARER_TOKEN}`;

  const isBodyless = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: isBodyless ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const raw = await upstream.text();

    // Rewrite absolute URLs inside FHIR Bundles (pagination links, fullUrl)
    // so the browser keeps talking to this proxy instead of the raw server.
    // e.g. "https://server/fhir/Patient?page=2"  ->  "/Patient?page=2"
    // Matching is scheme-agnostic: some servers echo links over http:// even
    // when the base URL is https://.
    let body = raw;
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('json') && raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.resourceType === 'Bundle') {
          const basePath = new URL(FHIR_BASE_URL).pathname;
          const toProxyPath = (u) => {
            try {
              const parsedUrl = new URL(u);
              if (basePath === '/' || parsedUrl.pathname.startsWith(basePath)) {
                const rest = parsedUrl.pathname.slice(basePath === '/' ? 0 : basePath.length);
                return rest + parsedUrl.search;
              }
            } catch {
              /* not an absolute URL — leave unchanged (e.g. already relative) */
            }
            return u;
          };
          for (const link of parsed.link || []) {
            if (typeof link.url === 'string') link.url = toProxyPath(link.url);
          }
          for (const entry of parsed.entry || []) {
            if (typeof entry.fullUrl === 'string') entry.fullUrl = toProxyPath(entry.fullUrl);
          }
          body = JSON.stringify(parsed);
        }
      } catch {
        /* not parseable — forward the raw body unchanged */
      }
    }

    res.status(upstream.status);
    res.set('Content-Type', contentType || 'application/json');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(body);
  } catch (err) {
    console.error(`[fhir-proxy] ${req.method} ${target} failed:`, err.message);
    const status = err.name === 'TimeoutError' ? 504 : 502;
    res.status(status).json({
      error: 'Could not reach the FHIR server.',
      detail: err.message,
      hint: 'Check that FHIR_BASE_URL in .env is correct and reachable from this machine.',
    });
  }
});

// ── Static frontend ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── JSON parse errors -> friendly 400 ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.', detail: err.message });
  }
  console.error('[patient-manager] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  FHIR Patient Manager                                        │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log(`  Web UI      : http://localhost:${PORT}`);
  console.log(`  FHIR proxy  : http://localhost:${PORT}${PROXY_PREFIX}/*`);
  console.log(`  Upstream    : ${FHIR_BASE_URL}`);
  console.log(`  Auth header : ${FHIR_BEARER_TOKEN ? 'Authorization: Bearer <configured>' : 'none (public server)'}`);
});
