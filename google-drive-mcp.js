#!/usr/bin/env node

// Stdio MCP adapter that exposes Google Drive file operations to Executor.
// Credentials come from the local gcloud CLI (`gcloud auth print-access-token`),
// so the signed-in gcloud account must have Drive access, for example via
// `gcloud auth login --enable-gdrive-access`.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFile } = require("node:child_process");

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DEFAULT_GCLOUD_BIN = path.join(
  os.homedir(),
  ".local/lib/google-cloud-sdk/bin/gcloud"
);
const TOKEN_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 200_000;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const FILE_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink," +
  "owners(displayName,emailAddress),trashed,starred,driveId,description," +
  "shortcutDetails";
const EXPORT_DEFAULTS = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};
const CONVERT_TARGETS = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
};
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

const fileIdProperty = {
  type: "string",
  description: "Drive file ID, or a Drive/Docs URL that contains one",
};
const contentProperties = {
  text: {
    type: "string",
    description: "UTF-8 content to upload. Provide either text or local_path.",
  },
  local_path: {
    type: "string",
    description: "Absolute path of a local file to upload instead of text",
  },
  mime_type: {
    type: "string",
    description:
      "MIME type of the uploaded content. Defaults to text/plain for text " +
      "and application/octet-stream for local files.",
  },
};

const TOOLS = [
  {
    name: "searchDriveFiles",
    title: "Search Google Drive files",
    description:
      "Lists or searches Drive files visible to the gcloud account. Combine " +
      "the convenience filters or pass a raw Drive query in `query` (for " +
      "example \"fullText contains 'invoice'\"). Trashed files are excluded " +
      "unless include_trashed is true. Returns metadata and a nextPageToken.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Raw Drive `q` search expression" },
        name_contains: { type: "string", description: "Substring of the file name" },
        mime_type: { type: "string", description: "Exact MIME type to match" },
        parent_id: { type: "string", description: "Only direct children of this folder ID" },
        include_trashed: { type: "boolean", default: false },
        order_by: {
          type: "string",
          description: "Drive orderBy, for example 'modifiedTime desc'",
          default: "modifiedTime desc",
        },
        page_size: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        page_token: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "getDriveFile",
    title: "Get Google Drive file metadata",
    description: "Returns metadata for one Drive file or folder.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: { file_id: fileIdProperty },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "readDriveFile",
    title: "Read Google Drive file content",
    description:
      "Returns a Drive file's content. Google Docs export as Markdown, Sheets " +
      "as CSV (first sheet), Slides as plain text, and Drawings as PNG unless " +
      "export_mime_type overrides it. Text files return text and images " +
      "return image content. Other binary files (PDF, Office, archives) must " +
      "be saved with downloadDriveFile instead. Shortcuts are followed.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProperty,
        export_mime_type: {
          type: "string",
          description: "Export format for Google Workspace files",
        },
        max_chars: {
          type: "integer",
          minimum: 1,
          default: DEFAULT_MAX_TEXT_CHARS,
          description: "Truncate text content after this many characters",
        },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "downloadDriveFile",
    title: "Download a Google Drive file",
    description:
      "Saves a Drive file to an absolute local path, exporting Google " +
      "Workspace files (default formats as in readDriveFile; pass " +
      "export_mime_type such as application/pdf to override). Refuses to " +
      "overwrite an existing file unless overwrite is true.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProperty,
        destination_path: { type: "string", description: "Absolute local path" },
        export_mime_type: { type: "string" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["file_id", "destination_path"],
      additionalProperties: false,
    },
  },
  {
    name: "createDriveFile",
    title: "Create a Google Drive file",
    description:
      "Uploads a new Drive file from text or a local file. Set convert_to to " +
      "import it as a Google Doc, Sheet, or Slides file (for example Markdown " +
      "to a Doc or CSV to a Sheet).",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name in Drive" },
        parent_id: { type: "string", description: "Destination folder ID (defaults to My Drive)" },
        description: { type: "string" },
        convert_to: { type: "string", enum: Object.keys(CONVERT_TARGETS) },
        ...contentProperties,
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "updateDriveFileContent",
    title: "Replace Google Drive file content",
    description:
      "Replaces the content of an existing Drive file with text or a local " +
      "file. Drive keeps prior revisions of binary files.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: { file_id: fileIdProperty, ...contentProperties },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "createDriveFolder",
    title: "Create a Google Drive folder",
    description: "Creates a folder, optionally inside parent_id.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parent_id: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "updateDriveFileMetadata",
    title: "Rename, move, or star a Google Drive file",
    description:
      "Updates a file's name, description, or starred flag, and moves it by " +
      "adding parent folders and removing others.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProperty,
        name: { type: "string" },
        description: { type: "string" },
        starred: { type: "boolean" },
        add_parent_ids: { type: "array", items: { type: "string" } },
        remove_parent_ids: { type: "array", items: { type: "string" } },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "trashDriveFile",
    title: "Move a Google Drive file to the trash",
    description:
      "Moves a file or folder to the Drive trash, or restores it when " +
      "restore is true. Never deletes permanently.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProperty,
        restore: { type: "boolean", default: false },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
];

function requestError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function normalizeFileId(value, label = "file_id") {
  const raw = String(value ?? "").trim();
  if (raw === "root") return raw;
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    candidate =
      url.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ||
      url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ||
      url.searchParams.get("id") ||
      "";
  }
  if (!FILE_ID_PATTERN.test(candidate)) {
    throw new Error(`${label} is not a valid Drive file ID or URL`);
  }
  return candidate;
}

function quoteQueryValue(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function isTextMime(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/yaml",
      "application/x-yaml",
      "application/x-sh",
      "application/sql",
    ].includes(type)
  );
}

function createTokenProvider({
  gcloudBin = process.env.GCLOUD_BIN || DEFAULT_GCLOUD_BIN,
  account = process.env.GDRIVE_GCLOUD_ACCOUNT || "",
  execFileImpl = execFile,
} = {}) {
  let cached = null;
  return async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    const args = ["auth", "print-access-token"];
    if (account) args.push(`--account=${account}`);
    const token = await new Promise((resolve, reject) => {
      execFileImpl(
        gcloudBin,
        args,
        {
          timeout: 30_000,
          env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim().slice(0, 300);
            reject(new Error(`gcloud could not provide an access token: ${detail}`));
            return;
          }
          resolve(String(stdout).trim());
        }
      );
    });
    if (!token) throw new Error("gcloud returned an empty access token");
    cached = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  };
}

async function responseSummary(response) {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) return parsed.error.message;
    } catch {}
    return text.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

function createDriveClient({ getToken = createTokenProvider(), fetchImpl = fetch } = {}) {
  async function request(url, init = {}, { retry = true } = {}) {
    const token = await getToken({ forceRefresh: !retry });
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 && retry) return request(url, init, { retry: false });
    if (!response.ok) {
      const detail = await responseSummary(response);
      if (response.status === 403 && /scope/i.test(detail)) {
        throw new Error(
          `Drive API rejected the gcloud token's scopes: ${detail}. Run ` +
            "`gcloud auth login --enable-gdrive-access`."
        );
      }
      throw new Error(
        `Drive API request failed with HTTP ${response.status}` +
          (detail ? `: ${detail}` : "")
      );
    }
    return response;
  }

  function apiUrl(base, pathname, params = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async function json(url, init) {
    return (await request(url, init)).json();
  }

  async function getMetadata(fileId) {
    return json(
      apiUrl(DRIVE_API, `/files/${encodeURIComponent(fileId)}`, {
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      })
    );
  }

  async function resolveShortcut(metadata) {
    if (metadata.mimeType !== SHORTCUT_MIME) return metadata;
    const targetId = metadata.shortcutDetails?.targetId;
    if (!targetId) throw new Error("Drive shortcut has no target");
    return getMetadata(targetId);
  }

  async function fetchContent(metadata, exportMimeType) {
    const isWorkspaceFile = metadata.mimeType.startsWith("application/vnd.google-apps.");
    if (isWorkspaceFile) {
      if (metadata.mimeType === FOLDER_MIME) throw new Error("Folders have no content");
      const mimeType = exportMimeType || EXPORT_DEFAULTS[metadata.mimeType];
      if (!mimeType) {
        throw new Error(`Pass export_mime_type to export ${metadata.mimeType} files`);
      }
      const response = await request(
        apiUrl(DRIVE_API, `/files/${encodeURIComponent(metadata.id)}/export`, {
          mimeType,
        })
      );
      return { mimeType, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    if (exportMimeType && exportMimeType !== metadata.mimeType) {
      throw new Error("export_mime_type only applies to Google Workspace files");
    }
    const response = await request(
      apiUrl(DRIVE_API, `/files/${encodeURIComponent(metadata.id)}`, {
        alt: "media",
        supportsAllDrives: true,
      })
    );
    return {
      mimeType: metadata.mimeType,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }

  async function uploadBody({ text, local_path: localPath, mime_type: mimeType }) {
    if ((text === undefined) === (localPath === undefined)) {
      throw new Error("Provide exactly one of text or local_path");
    }
    if (text !== undefined) {
      return {
        bytes: Buffer.from(String(text), "utf8"),
        mimeType: mimeType || "text/plain",
      };
    }
    if (!path.isAbsolute(localPath)) throw new Error("local_path must be absolute");
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) throw new Error("local_path is not a regular file");
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`local_path exceeds the ${MAX_UPLOAD_BYTES}-byte upload limit`);
    }
    return {
      bytes: await fs.readFile(localPath),
      mimeType: mimeType || "application/octet-stream",
    };
  }

  async function multipartUpload(url, method, metadata, media) {
    const boundary = `executor-drive-${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${media.mimeType}\r\n\r\n`
      ),
      media.bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return json(url, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  return {
    async search(args) {
      const clauses = [];
      if (args.query) clauses.push(`(${args.query})`);
      if (args.name_contains) {
        clauses.push(`name contains ${quoteQueryValue(args.name_contains)}`);
      }
      if (args.mime_type) clauses.push(`mimeType = ${quoteQueryValue(args.mime_type)}`);
      if (args.parent_id) {
        clauses.push(`${quoteQueryValue(normalizeFileId(args.parent_id, "parent_id"))} in parents`);
      }
      if (!args.include_trashed) clauses.push("trashed = false");
      const pageSize = Math.min(Math.max(Number(args.page_size) || 25, 1), 100);
      return json(
        apiUrl(DRIVE_API, "/files", {
          q: clauses.join(" and "),
          orderBy: args.order_by || "modifiedTime desc",
          pageSize,
          pageToken: args.page_token,
          corpora: "allDrives",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
        })
      );
    },

    async get(args) {
      return getMetadata(normalizeFileId(args.file_id));
    },

    async read(args) {
      const metadata = await resolveShortcut(
        await getMetadata(normalizeFileId(args.file_id))
      );
      const content = await fetchContent(metadata, args.export_mime_type);
      return { metadata, ...content };
    },

    async download(args) {
      const destination = String(args.destination_path || "");
      if (!path.isAbsolute(destination)) {
        throw new Error("destination_path must be absolute");
      }
      const metadata = await resolveShortcut(
        await getMetadata(normalizeFileId(args.file_id))
      );
      const content = await fetchContent(metadata, args.export_mime_type);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content.bytes, { flag: args.overwrite ? "w" : "wx" });
      return {
        path: destination,
        bytes: content.bytes.length,
        mimeType: content.mimeType,
        file: { id: metadata.id, name: metadata.name },
      };
    },

    async create(args) {
      const media = await uploadBody(args);
      const metadata = { name: args.name };
      if (args.parent_id) metadata.parents = [normalizeFileId(args.parent_id, "parent_id")];
      if (args.description) metadata.description = args.description;
      if (args.convert_to) metadata.mimeType = CONVERT_TARGETS[args.convert_to];
      return multipartUpload(
        apiUrl(DRIVE_UPLOAD_API, "/files", {
          uploadType: "multipart",
          supportsAllDrives: true,
          fields: FILE_FIELDS,
        }),
        "POST",
        metadata,
        media
      );
    },

    async updateContent(args) {
      const fileId = normalizeFileId(args.file_id);
      const media = await uploadBody(args);
      return json(
        apiUrl(DRIVE_UPLOAD_API, `/files/${encodeURIComponent(fileId)}`, {
          uploadType: "media",
          supportsAllDrives: true,
          fields: FILE_FIELDS,
        }),
        { method: "PATCH", headers: { "Content-Type": media.mimeType }, body: media.bytes }
      );
    },

    async createFolder(args) {
      const metadata = { name: args.name, mimeType: FOLDER_MIME };
      if (args.parent_id) metadata.parents = [normalizeFileId(args.parent_id, "parent_id")];
      if (args.description) metadata.description = args.description;
      return json(
        apiUrl(DRIVE_API, "/files", { supportsAllDrives: true, fields: FILE_FIELDS }),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        }
      );
    },

    async updateMetadata(args) {
      const fileId = normalizeFileId(args.file_id);
      const patch = {};
      for (const key of ["name", "description", "starred"]) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      const ids = (list, label) =>
        (list || []).map((id) => normalizeFileId(id, label)).join(",");
      const addParents = ids(args.add_parent_ids, "add_parent_ids");
      const removeParents = ids(args.remove_parent_ids, "remove_parent_ids");
      if (!Object.keys(patch).length && !addParents && !removeParents) {
        throw new Error("Nothing to update");
      }
      return json(
        apiUrl(DRIVE_API, `/files/${encodeURIComponent(fileId)}`, {
          addParents,
          removeParents,
          supportsAllDrives: true,
          fields: FILE_FIELDS,
        }),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }
      );
    },

    async trash(args) {
      const fileId = normalizeFileId(args.file_id);
      return json(
        apiUrl(DRIVE_API, `/files/${encodeURIComponent(fileId)}`, {
          supportsAllDrives: true,
          fields: FILE_FIELDS,
        }),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: !args.restore }),
        }
      );
    },
  };
}

function readResult({ metadata, mimeType, bytes }, maxChars) {
  const header = `Drive file: ${metadata.name} (${metadata.id}, ${mimeType})`;
  if (mimeType.startsWith("image/")) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES}-byte limit; use downloadDriveFile`);
    }
    return {
      content: [
        { type: "text", text: header },
        { type: "image", data: bytes.toString("base64"), mimeType },
      ],
    };
  }
  if (!isTextMime(mimeType)) {
    throw new Error(
      `${mimeType} content is binary; use downloadDriveFile to save it locally`
    );
  }
  const limit = Math.max(Number(maxChars) || DEFAULT_MAX_TEXT_CHARS, 1);
  const text = bytes.toString("utf8");
  const truncated = text.length > limit;
  return {
    content: [
      {
        type: "text",
        text:
          `${header}${truncated ? ` [truncated to ${limit} of ${text.length} chars]` : ""}` +
          `\n\n${truncated ? text.slice(0, limit) : text}`,
      },
    ],
  };
}

async function callTool(name, args, drive) {
  switch (name) {
    case "searchDriveFiles":
      return jsonResult(await drive.search(args));
    case "getDriveFile":
      return jsonResult(await drive.get(args));
    case "readDriveFile":
      return readResult(await drive.read(args), args.max_chars);
    case "downloadDriveFile":
      return jsonResult(await drive.download(args));
    case "createDriveFile":
      return jsonResult(await drive.create(args));
    case "updateDriveFileContent":
      return jsonResult(await drive.updateContent(args));
    case "createDriveFolder":
      return jsonResult(await drive.createFolder(args));
    case "updateDriveFileMetadata":
      return jsonResult(await drive.updateMetadata(args));
    case "trashDriveFile":
      return jsonResult(await drive.trash(args));
    default:
      return requestError(`Unknown tool: ${name || "(missing)"}`);
  }
}

let defaultDrive;

async function handleRequest(message, options = {}) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "google-drive", version: "1.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: TOOLS };
  if (message.method === "tools/call") {
    const drive = options.drive || (defaultDrive ??= createDriveClient());
    try {
      return await callTool(message.params?.name, message.params?.arguments || {}, drive);
    } catch (error) {
      return requestError(error instanceof Error ? error.message : String(error));
    }
  }
  return null;
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runStdioServer() {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (message.id === undefined) return;
    try {
      const result = await handleRequest(message);
      if (result === null) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      writeMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: detail },
      });
    }
  });
}

if (require.main === module) runStdioServer();

module.exports = {
  TOOLS,
  createDriveClient,
  createTokenProvider,
  handleRequest,
  isTextMime,
  normalizeFileId,
  quoteQueryValue,
};
