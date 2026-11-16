// Config and HTTP client shared by the MCP server and the CLI. Both talk to the same
// Hookcrest API the dashboard uses, with a workspace API key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = process.env.HOOKCREST_CONFIG || path.join(os.homedir(), ".hookcrest", "config.json");

export function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // No config yet: `hookcrest login` writes one.
  }
  return {
    url: (process.env.HOOKCREST_URL || file.url || "https://app.hookcrest.com").replace(/\/$/, ""),
    apiKey: process.env.HOOKCREST_API_KEY || file.apiKey || null,
    pendingLogin: file.pendingLogin || null,
    projectId: process.env.HOOKCREST_PROJECT || file.projectId || null,
  };
}

export function writeConfig(patch) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // First write.
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...file, ...patch }, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
  return CONFIG_FILE;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, route, body, { token } = {}) {
  const cfg = readConfig();
  const key = token || cfg.apiKey;
  if (!key && !route.startsWith("/auth/") && !["/cli/device", "/cli/token", "/health"].includes(route)) throw new ApiError("Not signed in. Call hookcrest_login (or run `hookcrest login`).", 401);
  let res;
  try {
    res = await fetch(`${cfg.url}/api${route}`, {
      method,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(15000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Cannot reach ${cfg.url}.`, 503);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = res.ok ? text : { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status === 401 ? "Not signed in. Call hookcrest_login (or run `hookcrest login`)." : data?.error || `Hookcrest returned ${res.status}`, res.status);
  return data;
}

export const get = (route) => api("GET", route);
export const post = (route, body = {}) => api("POST", route, body);
export const patch = (route, body = {}) => api("PATCH", route, body);
export const del = (route) => api("DELETE", route);
