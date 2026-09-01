# FHIR Patient Manager

A patient management web app that reads and writes **all** patient data to a **FHIR R4** server
through the FHIR REST API — **no mock data, no local state**. The browser never talks to the FHIR
server directly: every request goes through a small **backend proxy** that injects the
`Authorization: Bearer <token>` header from a local `.env` (kept secret and gitignored).

```
┌─────────────┐   fetch (same origin)   ┌──────────────────────┐   HTTPS + Bearer header   ┌──────────────────┐
│   Browser   │ ──────────────────────► │  Node/Express proxy  │ ────────────────────────► │  FHIR R4 server  │
│ (public/)   │   /api/fhir/Patient…    │  (server.js)         │   /Patient, /Patient/{id} │                  │
└─────────────┘                         └──────────────────────┘                           └──────────────────┘
                                              ▲ token lives only here (.env)
```

## Features

- **List patients** — on load, fetches **all** patients from the server (follows FHIR Bundle
  pagination links) and shows full name, gender, and date of birth.
- **Create a patient** — validated form (given name, family name, gender, DOB) → `POST /Patient`
  with a valid FHIR R4 Patient resource → list refreshes from the server.
- **Edit a patient** — the *Edit* button re-reads the resource (`GET /Patient/{id}`), pre-fills the
  form, and on submit does a full `PUT /Patient/{id}` (preserving all other server fields) →
  list refreshes.
- **Search by name** — debounced input using the FHIR `name` search parameter for
  **partial (starts-with) matching** (`GET /Patient?name=…`). Servers that enable it can
  switch to true substring matching by using `name:contains` instead.
- **Loading & error states** — spinner while fetching/saving; clear, dismissible error banner with
  the HTTP status and FHIR OperationOutcome diagnostics when a request fails.

## Getting started

```bash
npm install

# 1. Configure your FHIR server (copy the template):
cp .env.example .env
#    FHIR_BASE_URL=https://your-fhir-server/fhir/r4
#    FHIR_BEARER_TOKEN=your-token-here      # optional, leave empty for public servers
#    PORT=3000

# 2. Run
npm start          # or: npm run dev  (auto-restarts on file changes)
```

Open **http://localhost:3000** — the header shows which server you are connected to and whether
Bearer auth is configured.

> ⚠️ **Secrets:** the FHIR Base URL and Bearer token live only in `.env` (gitignored). The token is
> injected by the proxy and never sent to, or stored in, the browser.

## Running with Docker

The project ships with a `Dockerfile`, `.dockerignore`, and `docker-compose.yml`.
**Secrets are never baked into the image** — they are injected at runtime from your local `.env`.

**Prerequisite:** Docker Engine / Docker Desktop (with the compose plugin).

```bash
# 1. Configure secrets once (same .env as the npm run):
cp .env.example .env
#    FHIR_BASE_URL=...   FHIR_BEARER_TOKEN=...   PORT=3000

# 2. Build & start
docker compose up --build -d
# open http://localhost:3000

# Useful commands
docker compose ps              # status (including health)
docker compose logs -f         # follow logs
docker compose down            # stop & remove the container
docker compose up -d --build   # rebuild after code changes
```

Or without Compose:

```bash
docker build -t fhir-patient-manager .
docker run --env-file .env -p 3000:3000 fhir-patient-manager
```

> **How the secret hand-off works:** `docker-compose.yml` uses `env_file: .env` (and
> `docker run --env-file .env`) so `FHIR_BASE_URL`, `FHIR_BEARER_TOKEN`, and `PORT` become
> environment variables inside the container. `server.js` reads them from `process.env`
> (`dotenv` simply finds no `.env` file inside the image — the variables are already set).
> If you start the container without them, the app fails fast with a clear message.

## How it works

### The proxy (`server.js`)

- Serves the static frontend from `public/`.
- `GET/POST/PUT /api/fhir/*` → forwards to `<FHIR_BASE_URL>/*` with the query string passed
  through unchanged, `_format=json` appended, and `Authorization: Bearer <token>` added when a
  token is configured.
- Rewrites absolute URLs inside FHIR **Bundles** (pagination `link` / `fullUrl`) to relative proxy
  paths, so the browser keeps paginating through the proxy.
- Returns upstream status codes and bodies verbatim; upstream failures become a clear `502/504`
  JSON error.

### Patient resource shape (FHIR R4)

```json
{
  "resourceType": "Patient",
  "name": [{ "use": "official", "family": "Doe", "given": ["Jane", "Mary"] }],
  "gender": "female",
  "birthDate": "1990-01-15"
}
```

- `name[0].given` — array of given names (multiple given names are split on spaces/commas).
- `name[0].family` — family name string.
- `gender` — one of `male | female | other | unknown`.
- `birthDate` — `YYYY-MM-DD` (enforced and validated, future dates rejected).

## Environment variables

| Variable           | Required | Description                                                        |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `FHIR_BASE_URL`    | yes      | FHIR R4 server Base URL, e.g. `https://fhir.example.com/fhir/r4`   |
| `FHIR_BEARER_TOKEN`| no       | Bearer token; the proxy sends `Authorization: Bearer <token>`.     |
| `PORT`             | no       | Local port for the UI + proxy (default `3000`).                    |

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `Could not reach the FHIR server` (502) | `FHIR_BASE_URL` is wrong or unreachable from this machine; check the URL in `.env` and that you can `curl` it. |
| `FHIR request failed (HTTP 401)` | The server needs auth — set `FHIR_BEARER_TOKEN` in `.env` and restart. |
| `HTTP 404` on `/Patient` | The Base URL is missing a path segment (e.g. `/fhir/r4`). Check the server's documentation/`metadata` endpoint. |
| `405` on search | The server disabled the `name:contains` modifier (HAPI-1258). The app already uses plain `?name=` (partial prefix match) by default, which works everywhere. |
| `Unable to determine...` on `npm install` (Windows) | Run `npm install --cache <writable-folder>` if npm's default cache is blocked. |
| Container exits immediately | You started it without env vars — pass `.env` via `--env-file` (or `docker compose up`, which uses `env_file`). The app fails fast with a clear message if `FHIR_BASE_URL` is missing. |

## Project structure

```
clinic/
├── server.js          # Express: static hosting + FHIR proxy (Bearer header here)
├── Dockerfile         # node:22-alpine image; secrets injected at runtime, not baked in
├── docker-compose.yml # docker compose up --build -d (env_file: .env)
├── .dockerignore      # keeps .env / node_modules out of the build context
├── public/
│   ├── index.html     # Single page: header, search, table, modal form, toast
│   ├── styles.css     # Design system (tokens, badges, modal, loading states)
│   └── app.js         # Fetch via proxy, validation, render, create/update/search
├── .env               # SECRETS — FHIR_BASE_URL, FHIR_BEARER_TOKEN (gitignored)
├── .env.example       # Template for .env
└── package.json
```
