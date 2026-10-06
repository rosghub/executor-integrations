# Executor integrations

These are MCP wrappers that I run as [Executor](https://executor.sh)
integrations. Each one adds something an existing tool lacks.

## Plane inline assets

Plane's MCP server returns work items and comments, but not the images embedded
in them. `plane-inline-assets-mcp.js` downloads those images through Plane's
REST API so an agent can see the screenshots on a ticket.

## Google Drive

`google-drive-mcp.js` uses `gcloud` login to call the Drive API to avoid it's native executor connector requiring a GCP client.

## Install

Clone the repo and point Executor's integrations directory at it:

```bash
git clone https://github.com/rosghub/executor-integrations.git
ln -s "$PWD/executor-integrations" ~/.local/share/executor/integrations
```

Register each script in Executor as a stdio MCP server that runs
`node <script>`. The Plane wrapper reads `PLANE_API_KEY` and
`PLANE_WORKSPACE_SLUG` from its Executor connection. The Drive wrapper needs a
`gcloud` login with Drive access:

```bash
gcloud auth login --enable-gdrive-access
```
