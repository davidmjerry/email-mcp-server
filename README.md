# Email MCP Server

A Node.js MCP (Model Context Protocol) server for sending and reading email via SMTP and IMAP. The underlying SMTP/IMAP clients are standards-based and can be pointed at any provider by changing environment variables.

> Originally based on anyrxo/email-mcp-server (MIT). Heavily modified and extended.

> **Disclaimer:** Not affiliated with Proton.

## Quick Start

```bash
git clone https://github.com/davidmjerry/email-mcp-server.git
cd email-mcp-server
npm install
npm run build
node dist/index.js
```

By default the MCP server listens on `http://127.0.0.1:3000` and exposes:

- `GET /sse` for the SSE stream
- `POST /messages?sessionId=...` for client messages

## Prerequisites

- **Node.js** 18+
- **SMTP credentials** (username/password) for the mail account you want to send from
- **IMAP access** for the mail account you want to read from

### Proton Bridge (IMAP)

If using ProtonMail, you must run Proton Bridge locally and point IMAP to it. Defaults:

- Host: `localhost`
- Port: `1143`

Adjust the IMAP settings via environment variables if your Bridge uses different values.

## Environment Setup

Create a `.env` file in the project root:

```env
# Required: account credentials (used for both SMTP and IMAP)
USERNAME=your-email@example.com
PASSWORD=your-password

# SMTP configuration (defaults shown)
SMTP_HOST=localhost
SMTP_PORT=587
# Optional: Force implicit TLS (true) or STARTTLS (false); defaults based on port
# SMTP_SECURE=false
# Optional: Allow self-signed certs (useful with Proton Bridge)
# SMTP_REJECT_UNAUTHORIZED=false

# IMAP configuration (defaults shown)
IMAP_HOST=localhost
IMAP_PORT=1143
# Optional: Force implicit TLS (true) or STARTTLS (false); defaults to false
# IMAP_SECURE=false
# Optional: Allow self-signed certs (useful with Proton Bridge)
# IMAP_REJECT_UNAUTHORIZED=false

# Optional: Debug logging
DEBUG=true

# Optional: MCP server configuration
MCP_HOST=127.0.0.1
MCP_PORT=3000
# MCP_ALLOWED_HOSTS=example.com,localhost
# Optional: require an MCP auth token (sent via Authorization: Bearer, X-MCP-Token, or ?token=)
# MCP_TOKEN=your-mcp-token
```

### Credentials and Dependencies

- **SMTP:** Any SMTP server that supports username/password authentication.
- **IMAP:** Any IMAP server that supports username/password authentication.
- **ProtonMail IMAP requires Proton Bridge.** The server expects IMAP connectivity; without it, read-only features will fail.

### ProtonMail Compatibility

This project officially works with ProtonMail. For ProtonMail:

- Use **Proton Bridge** for IMAP/SMTP access.
- Set SMTP_HOST to localhost, port 1025 (usually by default).
- Set IMAP_HOST to localhost, port 1143.
- Use the SMTP/IMAP credentials from Proton Bridge.

## Installation

```bash
npm install
npm run build
```

## Usage (MCP Layer)

Start the server:

```bash
node dist/index.js
```

Clients connect via Server-Sent Events (SSE):

- `GET /sse` to open a session
- `POST /messages?sessionId=...` to send MCP messages

If you set `MCP_TOKEN`, clients must include it using one of:

- `Authorization: Bearer <token>`
- `X-MCP-Token: <token>`
- `?token=<token>` query string

## Optional: systemd Service

Create `/etc/systemd/system/email-mcp.service`:

```ini
[Unit]
Description=Email MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/email-mcp-server
ExecStart=/usr/bin/node /path/to/email-mcp-server/dist/index.js
Restart=on-failure
EnvironmentFile=/path/to/email-mcp-server/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable email-mcp
sudo systemctl start email-mcp
```

## Supported Features

- SMTP send (text/HTML)
- Attachments (base64)
- Multiple recipients (to/cc/bcc)
- Reply-to
- Priority headers
- Read receipt headers
- IMAP folder listing and status
- IMAP pagination and search
- IMAP read/unread and starred flags
- Move and delete (via trash folder detection)
- Basic analytics (contact counts, volume trends)

## Available Tools

### Email Sending
- `send_email`
- `send_test_email`

### Email Reading
- `get_emails`
- `get_email_by_id`
- `search_emails`

### Folder Management
- `get_folders`
- `sync_folders`

### Email Actions
- `mark_email_read`
- `star_email`
- `move_email`
- `delete_email`

### Threading & Conversations
- `get_thread`

### Analytics & Statistics
- `get_email_stats`
- `get_email_analytics`
- `get_contacts`
- `get_volume_trends`

### System & Maintenance
- `get_connection_status`
- `sync_emails`
- `clear_cache`
- `get_logs`

## License

MIT License.
