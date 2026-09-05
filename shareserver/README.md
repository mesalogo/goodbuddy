# ShareServer interactive prototype

This directory contains the first runnable ShareServer project. It is an
interactive control-console prototype based on the
[ShareServer PRD](../docs/features/share-server/prd.md), not a production
ShareServer implementation.

## Included

- Hono HTTP service with health, readiness, prototype snapshot, and prototype
  action endpoints.
- Same-origin React, Vite, TypeScript, Tailwind CSS, and shadcn/ui-style Web
  console.
- Administrator views for overview, members, devices, capabilities, policies,
  approvals, releases, federation, tasks, audit, and settings.
- Member self-service views for personal devices, grants, and requests.
- Responsive navigation, dark and light themes, search, filters, details,
  forms, confirmations, and keyboard-accessible dialogs.
- Production build and a non-root container image.

The UI uses official shadcn/ui conventions and Radix primitives. Its information
architecture was informed by the MIT-licensed
[`satnaing/shadcn-admin`](https://github.com/satnaing/shadcn-admin), but this
project does not copy that template or include its Clerk integration and sample
business pages.

## Not included yet

Prototype records are deliberately read-only fixtures. The action endpoint
returns an acknowledgement but does not persist changes. PostgreSQL,
initialization and login, organization isolation, real authorization, device
WebSocket connections, task routing, relay, package storage, federation, and
auditable mutations remain production implementation work.

The readiness endpoint reports this explicitly:

```json
{
  "status": "ready",
  "mode": "interactive-prototype",
  "productionReady": false
}
```

## Run locally

```text
cd shareserver
npm install
npm run dev
```

Open `http://127.0.0.1:5174`. Vite proxies `/api` to the Hono service on port
`8787`.

## Run the production build

```text
cd shareserver
npm run build
npm start
```

Open `http://127.0.0.1:8787`.

Set `SHARESERVER_PORT` to use another listen port. Local runs bind to
`127.0.0.1` by default; set `SHARESERVER_HOST` explicitly when a trusted reverse
proxy or container needs another interface. Do not expose the prototype as a
production service.

## Container

```text
docker build -t goodbuddy-shareserver-prototype ./shareserver
docker run --rm -p 8787:8787 goodbuddy-shareserver-prototype
```

## Validation

```text
npm test
npm run typecheck
npm run lint
npm run build
```
