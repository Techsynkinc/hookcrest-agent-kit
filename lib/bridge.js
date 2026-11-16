// Transport and local conveniences only. Tool schemas and workflows come from /mcp.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readConfig, ApiError } from "./client.js";
import { chatLogin } from "./login.js";

const SIGN_IN = "Not signed in. Call hookcrest_login first (or run `hookcrest login`).";
const login = {
  name: "hookcrest_login",
  title: "Sign in to Hookcrest",
  description: "Sign in locally. Open the returned link and approve the code, then call again. wait=true polls briefly. Sign in first to list the hosted tools.",
  inputSchema: { type: "object", properties: { wait: { type: "boolean", description: "Wait up to 45 seconds for approval." } }, additionalProperties: false },
  annotations: { title: "Sign in to Hookcrest", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
// The bridge's tool list grows after sign-in; the entry point sends tools/list_changed then.
export const events = { toolsChanged: () => {} };
export const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const content = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

function imageFileAsDataUrl(file) {
  const full = path.resolve(file.replace(/^~(?=$|\/)/, os.homedir()));
  let src = full;
  let ext = path.extname(full).toLowerCase();
  let temp;
  try {
    if (process.platform === "darwin" && (/\.(heic|heif|tiff?)$/.test(ext) || fs.statSync(full).size > 5_000_000)) {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), "hookcrest-photo-"));
      src = path.join(temp, "photo.jpg");
      execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1600", full, "--out", src], { stdio: "ignore" });
      ext = ".jpg";
    }
    const type = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[ext];
    if (!type) throw new Error("Use JPEG, PNG, WebP or (on a Mac) HEIC/TIFF.");
    return `data:${type};base64,${fs.readFileSync(src).toString("base64")}`;
  } finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
}

async function forward(msg) {
  const cfg = readConfig();
  let res;
  try {
    res = await fetch(`${cfg.url}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(msg), signal: AbortSignal.timeout(180000), redirect: "error",
    });
  } catch { throw new ApiError(`Cannot reach ${cfg.url}. Check the server URL and your connection.`, 503); }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new ApiError(res.status === 401 ? SIGN_IN : res.status === 429 ? `Too many requests. Wait ${res.headers.get("retry-after") || "60"} seconds before retrying.` : `Hookcrest HTTP ${res.status}: ${detail}`, res.status);
  }
  if (res.status === 202 || res.status === 204) return null;
  try { return await res.json(); } catch { throw new ApiError("Invalid JSON response from Hookcrest.", 502); }
}

export async function handle(msg) {
  const id = msg?.id;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  try {
    if (msg?.jsonrpc === "2.0" && msg.method === "tools/call" && msg.params?.name === login.name) {
      if (id === undefined) return null;
      const args = msg.params.arguments ?? {};
      if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((k) => k !== "wait") || (args.wait !== undefined && typeof args.wait !== "boolean")) return failure(id, -32602, "Invalid login arguments.");
      const out = await chatLogin(args);
      if (out.data?.status === "approved") events.toolsChanged();
      return reply(content(`${out.summary}\n\n${JSON.stringify(out.data)}`));
    }
    let outgoing = msg;
    const args = msg?.params?.arguments;
    let saveDir;
    if (msg?.method === "tools/call" && args && typeof args === "object") {
      const local = { ...args };
      if (msg.params.name === "influencer_photo" && local.file !== undefined) {
        if (typeof local.file !== "string") throw new Error("file must be a local path.");
        local.image_data = imageFileAsDataUrl(local.file);
        delete local.file;
      }
      if (msg.params.name === "post_preview" && local.save_dir !== undefined) {
        if (typeof local.save_dir !== "string") throw new Error("save_dir must be a local folder path.");
        saveDir = path.resolve(local.save_dir.replace(/^~(?=$|\/)/, os.homedir()));
        delete local.save_dir;
      }
      outgoing = { ...msg, params: { ...msg.params, arguments: local } };
    }
    const response = await forward(outgoing);
    if (msg?.method === "initialize" && response?.result?.capabilities) response.result.capabilities.tools = { listChanged: true };
    if (msg?.method === "tools/list" && response?.result?.tools) {
      response.result.tools = response.result.tools.filter((t) => t.name !== login.name);
      response.result.tools.push(login);
      for (const t of response.result.tools) {
        if (t.name === "influencer_photo") {
          t.inputSchema.properties.file = { type: "string", description: "Local photo path; the bridge uploads it as image_data. HEIC/TIFF and photos over 5 MB are converted with sips on a Mac." };
          t.description += " This local bridge also accepts file paths.";
        }
        if (t.name === "post_preview") t.inputSchema.properties.save_dir = { type: "string", description: "Save the returned preview images to this local folder (server preview resolution)." };
      }
    }
    if (saveDir && response?.result && !response.result.isError) {
      const files = [];
      for (const c of response.result.content || []) {
        if (c.type !== "image") continue;
        const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[c.mimeType];
        if (!ext) throw new Error(`Unsupported preview image type: ${c.mimeType}`);
        fs.mkdirSync(saveDir, { recursive: true });
        const file = path.join(saveDir, `preview-${files.length + 1}.${ext}`);
        fs.writeFileSync(file, Buffer.from(c.data, "base64"));
        files.push(file);
      }
      response.result.content.push({ type: "text", text: `Saved preview images:\n${files.join("\n")}` });
    }
    return response;
  } catch (e) {
    if (id === undefined && msg?.method) return null;
    if (e.status === 401 && msg?.method === "initialize") return reply({ protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "hookcrest", title: "Hookcrest", version: "0.3.0" }, instructions: SIGN_IN });
    if (e.status === 401 && msg?.method === "tools/list") return reply({ tools: [login] });
    if (e.status === 401 && msg?.method === "tools/call") return reply(content(SIGN_IN, true));
    return failure(id ?? null, -32000, e.message);
  }
}
