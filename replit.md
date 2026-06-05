# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 with Socket.IO
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **Bot library**: @whiskeysockets/baileys

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server + WhatsApp Bot Manager
│   └── dark-thila-bot/     # React + Vite dashboard frontend
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml     # pnpm workspace
├── tsconfig.base.json      # Shared TS options
├── tsconfig.json           # Root TS project references
└── package.json            # Root package
```

## Dark Thila Bot

A multi-user WhatsApp Bot with a dark dashboard UI.

### Architecture

- **Frontend**: React + Vite at `/` — dark-themed hacker aesthetic dashboard for managing bot sessions
- **Backend**: Express + Socket.IO at `/api` — handles WhatsApp bot sessions via Baileys
- **Real-time**: Socket.IO at `/api/socket.io` for live session status updates

### Bot Session Flow

1. User creates a session via dashboard (POST /api/connect)
2. Backend creates a Baileys WebSocket connection per session
3. QR code or pairing code is sent to frontend via Socket.IO
4. User scans QR or enters pairing code in WhatsApp
5. Session connects and bot handles commands

### Bot Commands

- `.menu` — Show all commands with logo
- `.alive` — Check bot uptime and status
- `.kick` — Remove member from group (owner + group only)
- `.add` — Add member to group (owner + group only)
- `.promote` — Make member admin (owner + group only)
- `.demote` — Remove admin (owner + group only)
- `.bc [msg]` — Broadcast to all groups (owner only)
- `.setlogo [url]` — Change bot logo (owner only)
- `.fbdl [url]` — Download Facebook video
- `.ttdl [url]` — Download TikTok video (no watermark)
- `.song [name/url]` — Download YouTube audio as MP3

### Sessions

Sessions are stored in `artifacts/api-server/sessions/<sessionId>/`:
- `meta.json` — session metadata (phone, method, owner, logo)
- `auth.db` — Baileys SQLite auth state (only used as fallback)
- Other JSON files — contacts, group settings, lid mappings, etc.

**Session persistence (MongoDB):**

If `MONGODB_URI` env var is set, Baileys creds + signal keys are stored in
MongoDB instead of local SQLite. This survives Render Free tier ephemeral
disk wipes — sessions auto-reconnect after every redeploy.

- `useMongoAuthState.js` — drop-in MongoDB-backed Baileys auth state
- Collections: `bot_creds` (one doc/session), `bot_keys` (one doc/key)
- Falls back to SQLite if `MONGODB_URI` is not set
- Logout / `_clearCredsAndAuthFiles` also wipes Mongo docs for that session

Sessions are automatically restored on server restart.

### API Endpoints

- `GET /api/sessions` — List all sessions
- `POST /api/connect` — Create new session `{ sessionId, phoneNumber, method: 'qr'|'pairing' }`
- `POST /api/disconnect` — Remove session `{ sessionId }`
- `GET /api/status/:sessionId` — Get session status

## TypeScript & Composite Projects

Every lib package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all lib packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — only emit `.d.ts` files during typecheck
- Bot JS files in `src/bot/` are plain ES modules, not compiled by TypeScript (they use dynamic imports)

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly`

## Key Dependencies

### api-server
- `@whiskeysockets/baileys` — WhatsApp Web API
- `socket.io` — Real-time events
- `qrcode` — QR code generation
- `axios` — HTTP requests for download commands
- `@distube/ytdl-core` — YouTube downloads
- `yt-search` — YouTube search
- `fluent-ffmpeg` + `ffmpeg-static` — Audio conversion

### dark-thila-bot (frontend)
- `socket.io-client` — Real-time connection to bot server
- `@workspace/api-client-react` — Generated React Query hooks
