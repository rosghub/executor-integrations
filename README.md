# Executor integrations

Small, dependency-free stdio MCP adapters that are registered as
[Executor](https://executor.sh) integrations. Executor launches each script with
Node and exchanges newline-delimited JSON-RPC messages over stdin and stdout.

| Script | Executor slug | Credentials |
| --- | --- | --- |
| `plane-inline-assets-mcp.js` | `plane_inline_assets` | `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG` from the Executor connection |
| `google-drive-mcp.js` | `google_drive` | Access token from the local `gcloud` CLI |

No credentials are stored in this repository. Executor supplies environment
variables from its connection store, and the Drive adapter asks `gcloud` for a
short-lived token on demand.

## Plane inline assets

`readPlaneInlineImage` fetches images referenced by `<image-component>` elements
in Plane work-item descriptions and comments, using Plane's API-key REST API, and
returns them as MCP image content.

## Google Drive

Tools:

- `searchDriveFiles`, `getDriveFile`, `readDriveFile` (read-only)
- `downloadDriveFile`, `createDriveFile`, `updateDriveFileContent`,
  `createDriveFolder`, `updateDriveFileMetadata`, `trashDriveFile`

`readDriveFile` exports Google Docs as Markdown, Sheets as CSV, Slides as plain
text, and Drawings as PNG. It returns text files as text and images as image
content. Other binary files must be saved locally with `downloadDriveFile`.
`trashDriveFile` only moves files to or from the trash.

The `gcloud` account needs the Drive scope:

```bash
gcloud auth login --enable-gdrive-access
```

Optional environment variables:

- `GCLOUD_BIN`: path to `gcloud`. Defaults to
  `~/.local/lib/google-cloud-sdk/bin/gcloud`.
- `GDRIVE_GCLOUD_ACCOUNT`: `gcloud` account to use instead of the active one.

## Installation

Executor references the scripts at `~/.local/share/executor/integrations/`,
which is a symlink to this checkout:

```bash
ln -s "$PWD" ~/.local/share/executor/integrations
```

Register an adapter with Executor's built-in tools, replacing the paths with
absolute paths for your machine:

```bash
executor call executor mcp addServer '{
  "transport": "stdio",
  "slug": "google_drive",
  "name": "Google Drive",
  "command": "/absolute/path/to/node",
  "args": ["/home/you/.local/share/executor/integrations/google-drive-mcp.js"],
  "cwd": "/home/you/.local/share/executor/integrations",
  "spawnPerCall": false
}'
```

Executor pauses the call until you approve it. The Plane adapter also needs an
authentication template with a `stdio_env` entry for `PLANE_API_KEY` and
`PLANE_WORKSPACE_SLUG`, plus a connection that supplies their values.

## Tests

```bash
npm test
```

The tests use stubbed `fetch` responses and do not contact Google or Plane.
