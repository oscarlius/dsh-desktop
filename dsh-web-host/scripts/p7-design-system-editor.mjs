import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { installCompanyDesignSystemBrowser } from "./p7-design-system-editor-browser.mjs";

const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
const BASE = "/api/p7/artifacts/design-system";
const EDITOR = BASE + "/editor";
const GATEWAY = BASE + "/gateway";
const MANIFEST = "dsh-claude-design-system/package.json";
const ATTESTATION_KEY = "/run/p7-web/attestation.key";
const UPSTREAM = "http://127.0.0.1:4730";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const SCRIPT = "assets/index-B-iGKpzB.js";
const STYLES = "assets/index-BhzAAcg0.css";
const FONT = "assets/anthropicons-fizzy-lake-BSKaZSiT.woff2";
const PUBLIC_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};
const DATA_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function companyDesignSystemEditorId(root) {
  return createHash("sha256").update(root).digest("base64url").slice(0, 22);
}

function runtimeConfig(env) {
  const workspace = env.P7_DESIGN_SYSTEM_EDITOR_WORKSPACE;
  const home = env.DSH_HOME;
  try {
    const url = new URL(env.DSH_WEB_PUBLIC_URL);
    const mount = "/dsh/instances/" + workspace;
    if (!UUID.test(workspace ?? "") || url.protocol !== "https:" || url.username || url.password ||
        url.hash || url.search || url.pathname !== mount + "/") return null;
    if (!isAbsolute(home ?? "")) return null;
    return { workspace, url, mount, directories: [join(home, "home"), "/workspace"] };
  } catch {
    return null;
  }
}

function canonicalDirectory(path) {
  try {
    return isAbsolute(path) && realpathSync(path) === path && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function eligibleRoot(root, directories) {
  if (typeof root !== "string" || root.length > 4096 || !canonicalDirectory(root)) return false;
  const within = directories.some(dir => {
    const rel = relative(dir, root);
    return rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel) && canonicalDirectory(dir);
  });
  if (!within || !canonicalDirectory(join(root, "project"))) return false;
  try {
    return lstatSync(join(root, "project", "design-system.json")).isFile();
  } catch {
    return false;
  }
}

export function companyDesignSystemEditorUrl(root) {
  const config = runtimeConfig(process.env);
  if (!config || !eligibleRoot(root, config.directories)) return null;
  const url = new URL(config.mount + EDITOR, config.url);
  url.searchParams.set("id", companyDesignSystemEditorId(root));
  return url.href;
}

function isRegistered(record, root) {
  return record?.root === root && record.skill === "claude-design-system" &&
    record.plugin === "dsh-claude-design-system" && typeof record.sessionId === "string" && record.sessionId.length > 0;
}

function serverState(root, id) {
  try {
    const file = join(root, ".artifact-server.json");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state.root !== root || state.kind !== "design-system" || state.port !== 4730 ||
        state.url !== UPSTREAM + "/design-system/" + id + "/" ||
        !Number.isInteger(state.pid) || state.pid <= 1) return null;
    return state;
  } catch (error) {
    return error.code === "ENOENT" ? undefined : null;
  }
}

function readState(root, id) {
  try {
    const state = serverState(root, id);
    if (!state) return false;
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function privateNativeRoot(root) {
  try {
    const file = join(root, ".sharing.json");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    return !JSON.parse(readFileSync(file, "utf8")).lan;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

function confinedPath(root, path, expected = "file") {
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const stat = lstatSync(current);
      const directory = index !== parts.length - 1 || expected === "directory";
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }
  return true;
}

function safeNativeStorage(root) {
  return [".artifact-server.json", ".artifact-server.log", ".gitignore", "history/index.json", "project/_blobs/index.json"]
    .every(path => confinedPath(root, path)) &&
    confinedPath(root, "history/objects", "directory") && confinedPath(root, "project/_blobs", "directory");
}

async function localJson(path) {
  const response = await fetch(UPSTREAM + path, {
    redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) return null;
  const body = await readLimited(response.body, 8192);
  return body && JSON.parse(body);
}

async function nativeReady(root, id, build) {
  const state = serverState(root, id);
  if (!state || !readState(root, id) || !privateNativeRoot(root)) return false;
  try {
    const hub = await localJson("/__hub");
    if (hub?.hub !== 1 || hub.kind !== "design-system" || hub.host !== "127.0.0.1" ||
        hub.pid !== state.pid || hub.build !== build) return false;
    const session = await localJson("/design-system/" + id + "/__deck/session");
    return session?.canEdit === true && session.role === "owner";
  } catch {
    return false;
  }
}

function trusted(request, url, workspace, keyFile) {
  try {
    const header = name => request.headers.get("x-p7-web-" + name);
    const employee = header("employee"), generation = header("generation");
    const expires = header("expires"), supplied = header("signature");
    const now = Date.now(), expiry = Number(expires);
    if (!employee || employee.length > 512 || /[\r\n]/.test(employee) || !/^[1-9]\d{0,15}$/.test(generation ?? "") ||
        header("instance") !== workspace || !/^\d{13}$/.test(expires ?? "") || expiry <= now || expiry > now + 60_000 ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied ?? "")) return false;
    const stat = lstatSync(keyFile);
    if (!stat.isFile() || stat.size < 32 || stat.size > 4096 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return false;
    const key = readFileSync(keyFile, "utf8").trim();
    if (Buffer.byteLength(key) < 32) return false;
    const expected = createHmac("sha256", key).update(
      [request.method, url.pathname + url.search, employee, workspace, generation, expires].join("\n"),
    ).digest();
    return timingSafeEqual(expected, Buffer.from(supplied, "base64url"));
  } catch {
    return false;
  }
}

function publicResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...PUBLIC_HEADERS, "content-security-policy": DATA_CSP, ...headers } });
}

function message(status, text) {
  return publicResponse(JSON.stringify({ error: text }), status, { "content-type": "application/json; charset=utf-8" });
}

function routeQuery(url, names) {
  const params = url.searchParams;
  return [...params.keys()].every(key => names.includes(key) && params.getAll(key).length === 1);
}

function projectFile(path) {
  return path.length <= 512 && path.startsWith("project/") && path.split("/").every(
    part => part.length > 0 && !part.startsWith(".") && !/[\\%?#:\u0000-\u001f\u007f]/u.test(part),
  );
}

function upstreamPath(url, method) {
  if (url.search.length > 4096 || !routeQuery(url, ["id", "path", "client"])) return null;
  const path = url.searchParams.get("path") ?? "";
  const client = url.searchParams.get("client");
  if (client !== null && (!["__deck/events", "__presence"].includes(path) || !/^[A-Za-z0-9_-]{8,64}$/.test(client))) return null;
  const relay = path.split("/").map(encodeURIComponent).join("/") + (client ? "?client=" + client : "");
  if (method === "POST" && ["__deck/publish", "__deck/assets", "__presence"].includes(path)) return relay;
  if (!["GET", "HEAD"].includes(method)) return null;
  if (["_files.json", "__deck/session"].includes(path) || projectFile(path) || /^_blob\/[a-f0-9]{32}$/.test(path)) return relay;
  if (method === "GET" && path === "__deck/events") return relay;
  return null;
}

async function readLimited(body, max) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function sendNative(id, path, request, bytes, contentType) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (request.method === "POST") {
      headers.origin = UPSTREAM;
      headers["content-type"] = contentType;
      headers["content-length"] = bytes.length;
    }
    const client = request.headers.get("x-deck-client");
    if (/^[A-Za-z0-9_-]{8,64}$/.test(client ?? "")) headers["x-deck-client"] = client;
    const event = request.headers.get("last-event-id");
    if (/^[a-f0-9]{12}\.\d{1,12}$/.test(event ?? "")) headers["last-event-id"] = event;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
    const sent = httpRequest(UPSTREAM + "/design-system/" + id + "/" + path, {
      method: request.method, headers, signal, agent: false,
    }, resolve);
    sent.setTimeout(29_000, () => sent.destroy(new Error("Native editor transport timed out")));
    sent.once("error", reject);
    sent.end(bytes);
  });
}

function replacePinned(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Unexpected design-system editor bundle");
  return source.replace(before, () => after);
}

function editorAssets(manifest) {
  if (JSON.parse(readFileSync(manifest, "utf8")).version !== "2.16.0") throw new Error("Design-system editor version requires review");
  const scripts = join(dirname(manifest), "skills", "claude-design-system", "scripts");
  const server = realpathSync(join(scripts, "server.mjs"));
  const serverStat = statSync(server);
  const directory = join(scripts, "editor");
  const read = name => readFileSync(join(directory, name));
  const html = read("index.html").toString("utf8");
  let script = read(SCRIPT).toString("utf8");
  // The native live preview runs artifact-authored JS. Keep its fallback
  // sandboxed when sharing the authenticated Workspace origin.
  script = replacePinned(script, '"allow-scripts allow-same-origin"', '""');
  script = replacePinned(script, "ve=ae!==null&&!we(fe,q)?ae:null", "ve=null");
  script = replacePinned(script, "localComments:e=>{const a=LU({base:e,header:!0});return DU(),a},", "");
  return {
    html,
    cli: join(scripts, "artifact.mjs"),
    build: [server, serverStat.mtimeMs, serverStat.size].join(":"),
    files: new Map([
      [SCRIPT, [script, "text/javascript; charset=utf-8"]],
      [STYLES, [read(STYLES), "text/css; charset=utf-8"]],
      [FONT, [read(FONT), "font/woff2"]],
    ]),
  };
}

function renderEditor(assets, config, id) {
  const nonce = randomBytes(18).toString("base64");
  const prefix = config.mount + BASE;
  const gateway = prefix + "/gateway";
  const injected = "<script nonce=\"" + nonce + "\">(" + installCompanyDesignSystemBrowser.toString() +
    ")(" + JSON.stringify(gateway) + "," + JSON.stringify(id) + ");</script>";
  const page = assets.html.replace(/<script(?=\s|>)/g, "<script nonce=\"" + nonce + "\"")
    .replace("<head>", "<head>" + injected);
  const source = config.url.origin + prefix;
  const csp = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'unsafe-inline' " + source + "/" + STYLES,
    "font-src data: blob: " + source + "/" + FONT + " " + source + "/gateway",
    "img-src data: blob: " + source + "/gateway",
    "connect-src " + source + "/gateway",
    "frame-src about:",
    "media-src data: blob: " + source + "/gateway",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  return publicResponse(page, 200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp });
}

function escapeHtml(text) {
  return String(text).replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderList(items, config) {
  const links = items.map(({ id, title }) => "<li><a href=\"" + config.mount + EDITOR + "?id=" + id +
    "\">" + escapeHtml(title) + "</a></li>").join("");
  const html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>设计系统作品</title>" +
    "<h1>设计系统作品</h1>" + (links ? "<ul>" + links + "</ul>" : "<p>暂无已登记的设计系统。</p>") + "</html>";
  return publicResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
}

export function registerCompanyDesignSystemEditor(routes, { findArtifact, listArtifacts }, {
  env = process.env, keyFile = ATTESTATION_KEY, nativePackageManifest,
} = {}) {
  const config = runtimeConfig(env);
  if (!config) return;
  const assets = editorAssets(nativePackageManifest ?? require.resolve(MANIFEST));
  const opening = new Map();
  async function launch(item) {
    if (!safeNativeStorage(item.root)) return false;
    if (await nativeReady(item.root, item.id, assets.build)) return true;
    if (serverState(item.root, item.id) === null || !privateNativeRoot(item.root)) return false;
    const active = opening.get(item.id);
    if (active) return active;
    const work = runFile(process.execPath, [assets.cli, "open", item.root, "--port", "4730", "--host", "127.0.0.1"], {
      timeout: 12_000, maxBuffer: 64 * 1024, windowsHide: true,
      env: { ...process.env, NODE_USE_ENV_PROXY: "0", BAOYU_DESIGN_REMOTE_HOST: "off" },
    }).then(() => nativeReady(item.root, item.id, assets.build), () => false).finally(() => opening.delete(item.id));
    opening.set(item.id, work);
    return work;
  }
  const register = (path, methods, fetch) => routes.register({
    path, methods, requestBody: "buffered",
    fetch(request) {
      const url = new URL(request.url);
      if (!trusted(request, url, config.workspace, keyFile)) return message(404, "找不到此编辑器");
      const origin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== config.url.origin) ||
          (request.method === "POST" && (origin !== config.url.origin || (site !== null && site !== "same-origin")))) {
        return message(403, "编辑请求的来源无效");
      }
      return fetch(request, url);
    },
  });
  function projects() {
    return listArtifacts().flatMap(({ root, title }) => eligibleRoot(root, config.directories) &&
      isRegistered(findArtifact(root), root) ? [{ root, title, id: companyDesignSystemEditorId(root) }] : []);
  }
  register(EDITOR, ["GET"], async (_request, url) => {
    if (!routeQuery(url, ["id"])) return message(400, "编辑参数无效");
    const id = url.searchParams.get("id");
    if (id === null) return renderList(projects(), config);
    const item = PROJECT_ID.test(id) && projects().find(candidate => candidate.id === id);
    if (!item) return message(404, "找不到此编辑器");
    if (!await launch(item)) return message(503, "设计系统编辑器暂时无法启动");
    return renderEditor(assets, config, id);
  });
  for (const [path, [bytes, contentType]] of assets.files) {
    register(BASE + "/" + path, ["GET", "HEAD"], (request, url) => url.search
      ? message(400, "编辑参数无效")
      : publicResponse(request.method === "HEAD" ? null : bytes, 200, { "content-type": contentType }));
  }
  register(GATEWAY, ["GET", "HEAD", "POST"], async (request, url) => {
    const path = upstreamPath(url, request.method);
    if (path === null) return message(404, "找不到此编辑功能");
    const id = url.searchParams.get("id") ?? "";
    const item = PROJECT_ID.test(id) && projects().find(candidate => candidate.id === id);
    if (!item) return message(404, "找不到此编辑器");
    if (!readState(item.root, id) || !privateNativeRoot(item.root) || !safeNativeStorage(item.root)) {
      return message(503, "请在当前工作台重新打开此设计系统");
    }
    const requested = url.searchParams.get("path");
    if (requested.startsWith("project/") && !confinedPath(item.root, requested)) return message(404, "找不到此文件");
    const contentType = request.headers.get("content-type") ?? "";
    try {
      let bytes;
      if (request.method === "POST") {
        if (path === "__deck/assets" ? !/^(?:image|font|audio|video|application)\/[\w.+-]+$/i.test(contentType)
          : !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) return message(415, "文件格式无效");
        bytes = await readLimited(request.body, MAX_REQUEST);
        if (!bytes) return message(413, "内容超过 8 MiB");
        if (path === "__deck/publish") {
          let files;
          try { files = JSON.parse(bytes).files; } catch { return message(400, "保存参数无效"); }
          if (!files || typeof files !== "object" || Array.isArray(files) ||
              Object.keys(files).some(file => !projectFile(file) || !confinedPath(item.root, file))) {
            return message(400, "保存文件超出设计系统目录");
          }
        }
      }
      const native = await sendNative(id, path, request, bytes, contentType);
      const status = native.statusCode;
      const nativeType = String(native.headers["content-type"] ?? "");
      const readable = Readable.toWeb(native);
      if (!status || status < 200 || status >= 500 || status >= 300 && status < 400) {
        await readable.cancel();
        return message(502, "原生编辑器暂时不可用");
      }
      if (nativeType.startsWith("text/event-stream") && path.startsWith("__deck/events")) {
        return publicResponse(readable, status, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
      }
      const body = request.method === "HEAD" || status === 204 ? null : await readLimited(readable, MAX_RESPONSE);
      if (body === null && request.method !== "HEAD" && status !== 204) return message(502, "编辑器响应过大");
      let type = "application/octet-stream";
      if (nativeType.startsWith("application/json")) type = "application/json; charset=utf-8";
      else if (/^(?:image|font|audio|video)\/[\w.+-]+$/i.test(nativeType)) type = nativeType;
      else if (/^text\/(?:plain|css)(?:; charset=utf-8)?$/i.test(nativeType)) type = nativeType;
      return publicResponse(body, status, { "content-type": type });
    } catch {
      return message(502, "原生编辑器暂时不可用");
    }
  });
}
