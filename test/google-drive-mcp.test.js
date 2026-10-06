const assert = require("node:assert");
const test = require("node:test");
const drive = require("../google-drive-mcp.js");

const FILE_ID = "1AbCdEfGhIjKlMn";

function fakeClient() {
  const calls = [];
  let tokens = 0;
  let rejectNext = true;
  const client = drive.createDriveClient({
    getToken: async ({ forceRefresh }) =>
      `t${++tokens}${forceRefresh ? "-refreshed" : ""}`,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      if (rejectNext) {
        rejectNext = false;
        return new Response("expired", { status: 401 });
      }
      return Response.json({ id: "new-id", name: "new" });
    },
  });
  return { client, calls };
}

function callTool(client, name, args) {
  return drive.handleRequest(
    { method: "tools/call", params: { name, arguments: args } },
    { drive: client }
  );
}

test("normalizeFileId accepts IDs and Drive URLs", () => {
  for (const url of [
    `https://docs.google.com/document/d/${FILE_ID}/edit`,
    `https://drive.google.com/drive/folders/${FILE_ID}`,
    `https://drive.google.com/open?id=${FILE_ID}`,
    FILE_ID,
  ]) {
    assert.equal(drive.normalizeFileId(url), FILE_ID);
  }
  assert.equal(drive.normalizeFileId("root"), "root");
  assert.throws(() => drive.normalizeFileId("../etc"));
});

test("quoteQueryValue escapes quotes and backslashes", () => {
  assert.equal(drive.quoteQueryValue("it's a \\ test"), "'it\\'s a \\\\ test'");
});

test("createDriveFile retries 401 and sends a multipart upload", async () => {
  const { client, calls } = fakeClient();
  const result = await callTool(client, "createDriveFile", {
    name: "notes.md",
    text: "# hi",
    mime_type: "text/markdown",
    convert_to: "document",
    parent_id: FILE_ID,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.Authorization, "Bearer t2-refreshed");
  assert.equal(calls[1].url.pathname, "/upload/drive/v3/files");
  assert.equal(calls[1].url.searchParams.get("uploadType"), "multipart");
  const body = calls[1].init.body.toString();
  assert.match(body, /"mimeType":"application\/vnd.google-apps.document"/);
  assert.match(body, /Content-Type: text\/markdown\r\n\r\n# hi/);
});

test("updateDriveFileMetadata moves files with parent parameters", async () => {
  const { client, calls } = fakeClient();
  await callTool(client, "updateDriveFileMetadata", {
    file_id: FILE_ID,
    name: "renamed",
    add_parent_ids: ["2AbCdEfGhIjKlMn"],
    remove_parent_ids: ["root"],
  });
  const last = calls.at(-1);
  assert.equal(last.init.method, "PATCH");
  assert.equal(last.url.searchParams.get("addParents"), "2AbCdEfGhIjKlMn");
  assert.equal(last.url.searchParams.get("removeParents"), "root");
});

test("uploads require exactly one absolute content source", async () => {
  const { client } = fakeClient();
  const both = await callTool(client, "createDriveFile", {
    name: "a",
    text: "x",
    local_path: "/etc/hosts",
  });
  assert.ok(both.isError);
  assert.match(both.content[0].text, /exactly one/);
  const relative = await callTool(client, "createDriveFile", {
    name: "a",
    local_path: "relative.txt",
  });
  assert.ok(relative.isError);
  assert.match(relative.content[0].text, /absolute/);
});
