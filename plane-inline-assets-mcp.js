#!/usr/bin/env node

const readline = require("node:readline");

const PLANE_API_ORIGIN = "https://api.plane.so";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const TOOL = {
  name: "readPlaneInlineImage",
  title: "Read a Plane inline image",
  description:
    "Use this after retrieving a Plane work item and its comments. Inspect " +
    "description_html and every comment_html value for <image-component> " +
    "elements whose src attribute is a UUID. Pass the work item's project UUID " +
    "as project_id and each image UUID as asset_id. This tool retrieves the " +
    "image through Plane's API-key-authenticated REST API and returns the actual " +
    "image content for visual inspection.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        format: "uuid",
        description: "Project UUID returned with the Plane work item",
      },
      asset_id: {
        type: "string",
        format: "uuid",
        description: "UUID from an image-component src attribute",
      },
    },
    required: ["project_id", "asset_id"],
    additionalProperties: false,
  },
};

function requestError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function responseSummary(response) {
  try {
    return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

function detectedImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

async function fetchPlaneInlineImage({
  apiKey,
  workspaceSlug,
  projectId,
  assetId,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("PLANE_API_KEY is not configured");
  if (!WORKSPACE_SLUG_PATTERN.test(workspaceSlug)) {
    throw new Error("PLANE_WORKSPACE_SLUG is invalid");
  }
  if (!UUID_PATTERN.test(projectId)) throw new Error("project_id must be a UUID");
  if (!UUID_PATTERN.test(assetId)) throw new Error("asset_id must be a UUID");

  const metadataUrl =
    `${PLANE_API_ORIGIN}/api/v1/workspaces/` +
    `${encodeURIComponent(workspaceSlug)}/assets/${encodeURIComponent(assetId)}/`;
  const metadataResponse = await fetchImpl(metadataUrl, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!metadataResponse.ok) {
    const detail = await responseSummary(metadataResponse);
    throw new Error(
      `Plane asset lookup failed with HTTP ${metadataResponse.status}` +
        (detail ? `: ${detail}` : "")
    );
  }

  const metadata = await metadataResponse.json();
  const downloadUrl = new URL(metadata.asset_url);
  if (downloadUrl.protocol !== "https:") {
    throw new Error("Plane returned a non-HTTPS asset URL");
  }

  const imageResponse = await fetchImpl(downloadUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!imageResponse.ok) {
    throw new Error(`Plane image download failed with HTTP ${imageResponse.status}`);
  }
  const contentLength = Number(imageResponse.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Plane image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }

  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Plane image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  const declaredType = String(
    metadata.asset_type || imageResponse.headers.get("content-type") || ""
  )
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const mimeType = declaredType.startsWith("image/")
    ? declaredType
    : detectedImageType(bytes);
  if (!mimeType) throw new Error("The Plane asset is not a supported image");

  return {
    assetId,
    projectId,
    name: String(metadata.asset_name || `inline-image-${assetId}`),
    mimeType,
    bytes,
  };
}

async function handleRequest(message, options = {}) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "plane-inline-assets", version: "1.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: [TOOL] };
  if (message.method === "tools/call") {
    if (message.params?.name !== TOOL.name) {
      return requestError(`Unknown tool: ${message.params?.name || "(missing)"}`);
    }
    try {
      const args = message.params.arguments || {};
      const image = await fetchPlaneInlineImage({
        apiKey: options.apiKey ?? process.env.PLANE_API_KEY,
        workspaceSlug:
          options.workspaceSlug ?? process.env.PLANE_WORKSPACE_SLUG ?? "estimate-sync",
        projectId: args.project_id,
        assetId: args.asset_id,
        fetchImpl: options.fetchImpl,
      });
      return {
        content: [
          {
            type: "text",
            text: `Plane inline image: ${image.name} (${image.mimeType})`,
          },
          {
            type: "image",
            data: image.bytes.toString("base64"),
            mimeType: image.mimeType,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return requestError(message);
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
  TOOL,
  detectedImageType,
  fetchPlaneInlineImage,
  handleRequest,
};
