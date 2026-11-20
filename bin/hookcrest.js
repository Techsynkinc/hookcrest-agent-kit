#!/usr/bin/env node
// hookcrest CLI: the same tools as the MCP server, for terminals, scripts and agents without MCP.
//   hookcrest login                      sign in through the browser and save a workspace API key
//   hookcrest tools                      list every tool and its options
//   hookcrest <tool> [value] [--opt v]   run a tool; --json prints the raw result
import readline from "node:readline/promises";
import { startLogin, pollLogin } from "../lib/login.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { handle } from "../lib/bridge.js";
let TOOLS = [];
import { readConfig, writeConfig, api } from "../lib/client.js";

const ALIASES = {
  status: "hookcrest_status", projects: "project_list", use: "project_use", brand: "brand_context", accounts: "accounts_list",
  niche: "niche_get", hashtags: "niche_hashtags_refresh", discover: "niche_accounts_discover", track: "niche_account_track",
  outliers: "niche_outliers_refresh", search: "niche_search", adapt: "outlier_adapt", breakdown: "outlier_breakdown", remix: "outlier_remix", make: "post_create", images: "post_images", video: "post_video", "video-edit": "post_video_edit", influencers: "influencer_list", personas: "influencer_draft", influencer: "influencer_create", photos: "influencer_photos", photo: "influencer_photo", "edit-influencer": "influencer_edit", "delete-influencer": "influencer_delete", assign: "influencer_assign", "read-account": "account_read", persona: "account_persona", "save-persona": "account_persona_save", preview: "post_preview", review: "review_queue",
  edit: "post_edit", approve: "post_approve", reject: "post_reject", drafts: "post_send_to_drafts",
  needs: "needs_you", comments: "comments_list", "draft-replies": "comments_draft_replies", reply: "comment_reply", dismiss: "comment_dismiss",
  stats: "live_posts", hooks: "hooks_list", "more-hooks": "hooks_more", schedule: "schedule_list", unschedule: "post_unschedule", retry: "post_retry",
  resend: "post_resend_to_inbox", "boost-ideas": "boost_suggestions", boost: "post_boost", revenue: "post_revenue", link: "post_link",
};

function parseArgs(tool, argv) {
  const props = tool.input.properties || {};
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [rawKey, inline] = a.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-/g, "_");
    if (key === "json") continue;
    const spec = props[key];
    if (!spec) throw new Error(`${tool.name} has no option --${rawKey}. Run \`hookcrest tools\` to see options.`);
    if (spec.type === "boolean") {
      // --flag, --flag=false, or --flag false / --flag true.
      if (inline === undefined && /^(true|false)$/.test(argv[i + 1] || "")) args[key] = argv[++i] === "true";
      else args[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${rawKey} needs a value.`);
    if (spec.type === "integer") args[key] = Number(value);
    else if (spec.type === "array" && spec.items?.type === "object") args[key] = [...(args[key] || []), ...JSON.parse(value)];
    else if (spec.type === "array") args[key] = [...(args[key] || []), ...value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (spec.items?.type === "integer" ? Number(s) : s))];
    else args[key] = value;
  }
  // A bare value fills the first required option: `hookcrest preview <content_id>`.
  const required = (tool.input.required || []).filter((k) => !(k in args));
  positional.forEach((v, i) => {
    if (required[i]) args[required[i]] = v;
  });
  return args;
}

function usage() {
  const lines = TOOLS.map((t) => {
    const alias = Object.entries(ALIASES).find(([, v]) => v === t.name)?.[0];
    const opts = Object.entries(t.input.properties || {}).filter(([k]) => k !== "project_id")
      .map(([k, s]) => `--${k.replace(/_/g, "-")}${s.type === "boolean" ? "" : " <" + (s.enum ? s.enum.join("|") : s.type) + ">"}${(t.input.required || []).includes(k) ? " (required)" : ""}`);
    return `  ${t.name}${alias ? `  (or: ${alias})` : ""}\n      ${t.description}\n      ${opts.join("  ") || "no options"}`;
  });
  return `Usage: hookcrest <tool> [value] [--option value] [--json]\n\n  login [--url https://app.hookcrest.com] [--key hk_live_...] [--email you@example.com] [--workspace name]\n      Sign in through the browser (or with --email and a password, or --key) and save a workspace API key to ~/.hookcrest/config.json. A key works in one workspace only.\n\n${lines.join("\n\n")}\n`;
}

// Browser sign-in: the server gives a short code and a link; approving it in the browser
// (signed in to Hookcrest) creates a workspace API key that this CLI picks up.
async function browserLogin() {
  const pending = await startLogin();
  const { userCode, verificationUrl, interval, expiresAt } = pending;
  console.log(`\nOpen this link to sign in, and check the code matches: ${userCode}\n\n  ${verificationUrl}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [verificationUrl], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {}).unref();
  } catch {
    // No browser to open; the link above still works.
  }
  process.stdout.write("Waiting for you to approve it in the browser");
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const result = await pollLogin(pending);
    if (result.status === "pending") {
      process.stdout.write(".");
      continue;
    }
    process.stdout.write("\n");
    console.log(`Approved for ${result.org}.`);
    return readConfig().apiKey;
  }
  throw new Error("The sign-in code expired. Run hookcrest login again.");
}

async function login(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = (opt("url") || readConfig().url).replace(/\/$/, "");
  writeConfig({ url });
  let key = opt("key");
  if (!key && !opt("email")) key = await browserLogin();
  if (!key) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const email = opt("email") || (await rl.question("Hookcrest email: "));
    console.log(`Signing in to ${url} as ${email}.`);
    // Show the prompt but not what's typed after it.
    const prompt = "Password (nothing shows as you type; press Enter when done): ";
    rl._writeToOutput = (s) => {
      if (s.startsWith(prompt)) process.stdout.write(prompt);
      else if (s === "\r\n" || s === "\n") process.stdout.write(s);
    };
    const password = await rl.question(prompt);
    rl.close();
    process.stdout.write("\n");
    const { token } = await api("POST", "/auth/signin", { email, password });
    // A key works in one workspace only. --workspace picks it (name or id); otherwise the first
    // one this person can make keys in, and the others are listed.
    const orgs = (await api("GET", "/organizations", undefined, { token })).filter((o) => ["owner", "admin"].includes(o.role));
    if (!orgs.length) throw new Error("You need to be an owner or admin of a workspace to make an API key.");
    const want = opt("workspace");
    const org = want ? orgs.find((o) => o.id === want || o.name.toLowerCase() === want.toLowerCase()) : orgs[0];
    if (!org) throw new Error(`No workspace called "${want}". Yours: ${orgs.map((o) => o.name).join(", ")}.`);
    const created = await api("POST", `/organizations/${org.id}/api-keys`, { name: "Hookcrest agent kit" }, { token });
    key = created.secret;
    console.log(`The key works in ${org.name} only.${orgs.length > 1 && !want ? ` For another workspace run hookcrest login --workspace "<name>" (${orgs.filter((o) => o !== org).map((o) => o.name).join(", ")}).` : ""}`);
  }
  const file = writeConfig({ apiKey: key });
  const projects = await api("GET", "/projects");
  // A saved project from another workspace doesn't work with this key: drop it (or take the only one).
  const saved = readConfig().projectId;
  if (saved && !projects.some((p) => p.id === saved)) writeConfig({ projectId: projects.length === 1 ? projects[0].id : null });
  const ws = (await api("GET", "/organizations").catch(() => []))[0]?.name;
  console.log(`Signed in to ${url}${ws ? ` (workspace: ${ws})` : ""}. Key saved to ${file}.`);
  console.log(`Projects: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}`);
  if (projects.length > 1 && !readConfig().projectId) console.log("Pick one with: hookcrest use <project_id>");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "login") return login(rest);
  const listed = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  if (listed.error) throw new Error(listed.error.message);
  TOOLS = listed.result.tools.map((t) => ({ ...t, input: t.inputSchema }));
  const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "tools") return void process.stdout.write(usage());
  const tool = toolByName.get(ALIASES[cmd] || cmd.replace(/-/g, "_"));
  if (!tool) throw new Error(`Unknown command ${cmd}. Run \`hookcrest tools\`.`);
  const args = parseArgs(tool, rest);
  if (tool.name === "post_preview" && !args.save_dir) args.save_dir = path.resolve("hookcrest-previews");
  const response = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: args } });
  if (response.error) throw new Error(response.error.message);
  const text = response.result.content.find((c) => c.type === "text")?.text || "";
  if (response.result.isError) throw new Error(text);
  const split = text.indexOf("\n\n");
  let data;
  try { data = JSON.parse(text.slice(split + 2)); } catch { data = { text }; }
  const out = { summary: split < 0 ? text : text.slice(0, split), data };
  if (rest.includes("--json")) console.log(JSON.stringify(out.data, null, 2));
  else {
    console.log(out.summary);
    for (const c of response.result.content.slice(1)) if (c.type === "text") console.log(c.text);
    if (out.data?.saved_files?.length) console.log(`\nSlides saved:\n${out.data.saved_files.join("\n")}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
