// Shared, resumable browser sign-in for the CLI and chat clients.
import os from "node:os";
import { api, readConfig, writeConfig, ApiError } from "./client.js";

export async function startLogin() {
  const flow = await api("POST", "/cli/device", { client: `Hookcrest agent kit on ${os.hostname()}` });
  const pending = { ...flow, url: readConfig().url, expiresAt: Date.now() + flow.expiresIn * 1000 };
  writeConfig({ pendingLogin: pending });
  return pending;
}

export async function pollLogin(pending) {
  if (pending.url !== readConfig().url || pending.expiresAt <= Date.now()) {
    writeConfig({ pendingLogin: null });
    throw new ApiError("Sign-in expired or the server changed. Call hookcrest_login again.", 410);
  }
  try {
    const result = await api("POST", "/cli/token", { deviceCode: pending.deviceCode });
    writeConfig({ apiKey: result.apiKey, pendingLogin: null, projectId: null });
    return { status: "approved", org: result.org };
  } catch (e) {
    if (e.status === 428) return { status: "pending" };
    if ([403, 404, 410].includes(e.status)) writeConfig({ pendingLogin: null });
    throw e;
  }
}

let signingIn;
export function chatLogin(args = {}) {
  if (!signingIn) signingIn = resumeLogin(args).finally(() => { signingIn = null; });
  return signingIn;
}
async function resumeLogin({ wait = false } = {}) {
  let pending = readConfig().pendingLogin;
  if (!pending || pending.url !== readConfig().url || pending.expiresAt <= Date.now()) {
    pending = await startLogin();
    return loginLink(pending);
  }
  const until = Date.now() + (wait ? 45000 : 0);
  do {
    const result = await pollLogin(pending);
    if (result.status === "approved") return { summary: `Signed in to ${pending.url} (${result.org}).`, data: result };
    if (Date.now() + pending.interval * 1000 > until) break;
    await new Promise((r) => setTimeout(r, pending.interval * 1000));
  } while (Date.now() < until);
  return loginLink(pending);
}
function loginLink(pending) {
  return { summary: `Open ${pending.verificationUrl} and check code ${pending.userCode}. After approving, call hookcrest_login again.`, data: { status: "pending", verificationUrl: pending.verificationUrl, userCode: pending.userCode, expiresAt: pending.expiresAt } };
}
