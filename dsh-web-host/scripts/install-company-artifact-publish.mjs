import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifest = require.resolve("dsh-claude-artifacts/package.json");
if (require(manifest).version !== "2.16.0") throw new Error("Review the company publishing integration before upgrading dsh-claude-artifacts");
const dataManifest = require.resolve("dsh-claude-data/package.json");
if (require(dataManifest).version !== "2.16.0") throw new Error("Review the company publishing integration before upgrading dsh-claude-data");
const plugin = join(dirname(manifest), "lib");
const client = join(plugin, "client.js");
const backend = join(plugin, "index.js");
const dataBackend = join(dirname(dataManifest), "lib", "index.js");
function patch(file, pairs) {
  let content = readFileSync(file, "utf8");
  for (const [before, after] of pairs) {
    if (content.split(before).length !== 2) throw new Error("Unexpected upstream layout in " + file + ": " + before);
    content = content.replace(before, () => after);
  }
  writeFileSync(file, content);
}

const companySupport = String.raw`
  const companyReadyEvent = "plugin:p7-artifacts/finalized";
  const companyDigest = /^[a-f0-9]{64}$/;
  const companyPortal = "https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/";
  const companyKey = (value) => createHash("sha256").update(value).digest("hex");
  const companyRecordDir = (root, sessionId) => join(artifactsDir(), "company-publish", companyKey(JSON.stringify([root, sessionId])));
  const companyIdentity = (root, sessionId) => typeof root === "string" && root.length > 0 && root.length <= 4096 && typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256;
  const companyOwned = (root, sessionId) => {
    const record = findArtifact(root);
    return record?.skill === "claude-data" && record.plugin === "dsh-claude-data" && record.sessionId === sessionId;
  };
  const readCompanyJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const companyWrite = (file, value) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } finally { rmSync(tmp, { force: true }); }
  };
  const companyRevision = (root, sessionId, digest) => {
    if (!companyIdentity(root, sessionId)) return null;
    try {
      const dir = companyRecordDir(root, sessionId);
      const id = digest ?? readCompanyJson(join(dir, "latest.json")).digest;
      if (typeof id !== "string" || !companyDigest.test(id)) return null;
      const item = readCompanyJson(join(dir, id + ".json"));
      return item.root === root && item.sessionId === sessionId && item.digest === id && typeof item.html === "string" && companyKey(item.html) === id ? item : null;
    } catch { return null; }
  };
  const companyLinks = (url, manageUrl) => typeof url === "string" && typeof manageUrl === "string" && url.startsWith(companyPortal) && /^pub-[a-f0-9]{32}$/.test(url.slice(companyPortal.length)) && manageUrl === url + "/manage";
  const registerCompanyEditorOutput = (ctx) => {
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      if (decision.kind !== "accept" || Object.hasOwn(decision, "value")) return decision;
      const opened = openedEditor(exec, result);
      if (opened === null) return decision;
      let address;
      try { address = new URL(opened.url); } catch { return decision; }
      if (!isLoopbackName(address.hostname)) return decision;
      const content = (decision.content ?? result.content).map(block =>
        block.type === "text" ? { ...block, text: block.text.replaceAll(opened.url, "[Web DSH 容器内编辑器地址]") } : block);
      const editorUrl = opened.skill.name === "claude-design-system" ? companyDesignSystemEditorUrl(opened.root) : null;
      const guidance = opened.skill.name === "claude-data"
        ? "Data 看板的打开命令只登记作品。完成检查后用返回的 root 定稿，最终只可说「看板已定稿，等待成果站发布回执」。"
        : editorUrl
          ? "作品已登记。设计系统的公司 HTTPS 编辑链接：" + editorUrl + " 。请把此地址作为编辑链接交付。"
          : "作品已登记。若未收到可访问的公司 HTTPS 编辑链接，请回复「作品已生成，可在作品列表中找到，网页编辑入口待接入」。";
      return {
        ...decision,
        content: [...content, { type: "text", text: guidance + " 容器内编辑器地址仅供工具自检。正式分享链接由成果站的成功回执提供。" }],
      };
    });
  };
  const companyReceiptTrusted = (request, bytes) => {
    try {
      const supplied = request.headers.get("x-p7-artifact-receipt");
      if (!supplied || !companyDigest.test(supplied)) return false;
      const key = readFileSync("/run/p7-web/controller.token", "utf8").trim();
      if (!key) return false;
      const expected = createHmac("sha256", key).update(bytes).digest();
      return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
    } catch { return false; }
  };
  const companySnapshot = (root) => {
    const record = findArtifact(root);
    if (record?.skill !== "claude-data" || !existsSync(root)) return { error: "只支持已登记的 Data 看板" };
    let realRoot;
    const readArtifact = (file) => {
      const realFile = realpathSync(file);
      const rel = relative(realRoot, realFile);
      const info = statSync(realFile);
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || !info.isFile()) throw new Error("不能导出看板目录之外的文件");
      if (info.size > 15 * 1024 * 1024) throw new Error("看板文件超过 15 MiB，无法生成单文件快照");
      return readFileSync(realFile);
    };
    const readJson = (file) => JSON.parse(readArtifact(file).toString("utf8"));
    const dataUrl = (id) => {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("无效的附件标识");
      const file = join(root, "_blobs", id), bytes = readArtifact(file), meta = readJson(file + ".json");
      const type = typeof meta.contentType === "string" && /^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(meta.contentType) ? meta.contentType : "application/octet-stream";
      return "data:" + type + ";base64," + bytes.toString("base64");
    };
    try {
      realRoot = realpathSync(root);
      const db = join(root, "db"), pageDoc = readJson(join(db, "files", "index.html.json"));
      if (typeof pageDoc.text !== "string" || !pageDoc.text.trim()) throw new Error("看板没有可导出的 index.html");
      const docs = Object.create(null), datasets = Object.create(null), dir = join(db, "datasets");
      if (existsSync(dir)) for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(entry.name)) continue;
        const id = entry.name.slice(0, -5), data = readJson(join(dir, entry.name));
        docs["datasets/" + id] = data;
        const asset = data?.source?.kind === "file" && typeof data.source.url === "string" ? /^\/?_blob\/([a-f0-9]{32})$/.exec(data.source.url)?.[1] : null;
        if (asset) datasets[id] = { source: dataUrl(asset), format: typeof data.source.format === "string" ? data.source.format : "" };
      }
      const page = pageDoc.text.replace(/\/_blob\/([a-f0-9]{32})/g, (_, id) => dataUrl(id));
      const state = JSON.stringify({ datasets, docs }).replace(/</g, "\\u003c");
      function attachSnapshot(state) {
        function rows(text, format) {
          if (format === "json") {
            const value = JSON.parse(text);
            return Array.isArray(value) ? value : (value.data || []);
          }
          const separator = format === "tsv" ? "\t" : ",";
          const records = text.trim().split(/\r?\n/).map(row => row.split(separator));
          const columns = records.shift() || [];
          return records.map(row => Object.fromEntries(columns.map((key, index) => [key, row[index] || ""])));
        }
        window.dash = {
          data(id) {
            try {
              const dataset = state.datasets[id];
              if (!dataset) return { status: "error" };
              const bytes = Uint8Array.from(atob(dataset.source.split(",")[1]), item => item.charCodeAt(0));
              return { status: "ok", data: rows(new TextDecoder().decode(bytes), dataset.format) };
            } catch (error) {
              return { status: "error", error: String(error) };
            }
          },
          draw(name, callback) {
            if (callback) document.querySelectorAll("[data-draw]").forEach(element => {
              if (element.dataset.draw === name) callback(element);
            });
          },
          doc(path) { return state.docs[path]?.data ?? null; },
        };
      }
      const boot = "<script>(" + attachSnapshot.toString() + ")(" + state + ");</script>";
      const title = "<title>" + record.title.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</title>";
      const html = /<head(?:\s[^>]*)?>/i.test(page)
        ? page.replace(/<head(?:\s[^>]*)?>/i, tag => tag + title + boot)
        : "<!doctype html><meta charset=\"utf-8\">" + title + boot + page.replace(/^\s*<!doctype html>/i, "");
      if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error("看板快照超过 2 MiB");
      return { html };
    } catch (error) { return { error: error.message || "快照不可用" }; }
  };
  const registerCompanyFinalization = (ctx) => {
    const turns = new WeakMap();
    ctx.on("session/event", (session, event) => {
      if (session.header.origin === "subagent") return;
      if (event.type === "turn/start") {
        turns.set(session, { turn: event.data.turn, roots: new Set(), human: false });
        return;
      }
      const active = turns.get(session);
      if (!active) return;
      if (event.type === "user/message" && event.data.source.kind === "user") active.human = true;
      if (event.type !== "turn/end") return;
      turns.delete(session);
      if (!active.human || event.data.turn !== active.turn || event.data.reason.kind !== "completed") return;
      const sessionId = String(session.id);
      for (const root of active.roots) {
        let data = { sessionId, turn: active.turn, root, title: findArtifact(root)?.title || "Data 看板" };
        try {
          if (!companyOwned(root, sessionId)) throw new Error("看板已不属于当前会话");
          const snapshot = companySnapshot(root);
          if (snapshot.error) throw new Error(snapshot.error);
          const digest = companyKey(snapshot.html), dir = companyRecordDir(root, sessionId);
          data = { ...data, digest };
          if (!companyRevision(root, sessionId, digest)) companyWrite(join(dir, digest + ".json"), { ...data, html: snapshot.html });
          companyWrite(join(dir, "latest.json"), { digest });
        } catch (error) {
          const { digest, ...failed } = data;
          data = { ...failed, error: "无法生成可发布的看板快照" };
          ctx.logger?.warn?.(PLUGIN + ": could not freeze a Data artifact: " + error.message);
        }
        queueMicrotask(() => {
          try { appendPluginRecord(session, companyReadyEvent, data); }
          catch (error) { ctx.logger?.warn?.(PLUGIN + ": could not add the Data artifact card: " + error.message); }
        });
      }
    });
    ctx.inject(["tools"], (scope) => scope.tools.register(defineTool({
      name: "finalize_company_data_artifact",
      description: "Finalize a finished claude-data dashboard for the company Results Portal. Call after all dashboard edits, checks, and the foreground open command have succeeded. Use only for a finished deliverable requested by the human; never call for a preview, draft, or user's no-publish request. The chat displays the real private share link after the current turn completes; do not claim it is already published.",
      parameters: { root: { type: "string", required: true, description: "Exact dashboard root from this conversation's successful claude-data open output" } },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      async execute({ root }, exec) {
        const session = exec.agent?.session, active = session && turns.get(session);
        const sessionId = session && String(session.id);
        if (!active?.human || !companyIdentity(root, sessionId) || !companyOwned(root, sessionId)) throw new Error("只有当前人工会话中已登记的 Data 看板可定稿");
        if (!active.roots.has(root) && active.roots.size >= 4) throw new Error("每轮最多定稿 4 个看板");
        exec.signal.throwIfAborted();
        active.roots.add(root);
        return "看板已定稿，等待成果站发布回执。此工具只登记定稿请求，请按这一状态回复。成果站确认后，会话的发布卡片会显示正式链接。";
      },
    })));
  };
`;
const exportRoute = String.raw`
  routes.register({ path: "/api/p7/artifacts/export", methods: ["GET"], requestBody: "buffered", fetch: (request) => {
    const params = new URL(request.url).searchParams;
    const root = params.get("root") || "", finalized = params.get("finalized"), digest = params.get("digest");
    if ((params.has("preview") && finalized !== null) || (digest !== null && finalized === null) || params.getAll("finalized").length > 1 || params.getAll("digest").length > 1 || params.getAll("root").length !== 1) return json({ error: "无效的导出参数" }, 409);
    const result = finalized === null ? companySnapshot(root) : (companyIdentity(root, finalized) && companyOwned(root, finalized) ? companyRevision(root, finalized, digest) : null);
    if (!result) return json({ error: "看板尚未在此会话完成定稿" }, 409);
    if (result.error) return json({ error: result.error }, 409);
    const preview = params.get("preview") === "1";
    return new Response(result.html, { headers: { "Content-Type": preview ? "text/html; charset=utf-8" : "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'" }});
  }});
  routes.register({ path: "/api/p7/artifacts/auto-status", methods: ["GET"], requestBody: "buffered", fetch: (request) => {
    const params = new URL(request.url).searchParams;
    const digest = params.get("digest");
    const item = digest ? companyRevision(params.get("root"), params.get("sessionId"), digest) : null;
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!item) return new Response(JSON.stringify({ error: "找不到此版本的定稿" }), { status: 409, headers });
    const receipt = item.receipt;
    return new Response(JSON.stringify(companyLinks(receipt?.url, receipt?.manageUrl) ? { state: "published", ...receipt } : { state: "ready" }), { headers });
  }});
  routes.register({ path: "/api/p7/artifacts/auto-receipt", methods: ["POST"], requestBody: "buffered", fetch: async (request) => {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > 8192 || new URL(request.url).search || !companyReceiptTrusted(request, bytes)) return new Response(null, { status: 403 });
    let body;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { return new Response(null, { status: 400 }); }
    if (!body || typeof body.digest !== "string" || !companyDigest.test(body.digest) || !companyLinks(body.url, body.manageUrl)) return new Response(null, { status: 400 });
    const item = companyRevision(body.root, body.sessionId, body.digest);
    if (!item) return new Response(null, { status: 409 });
    if (item.receipt) return new Response(null, { status: item.receipt.url === body.url && item.receipt.manageUrl === body.manageUrl ? 204 : 409 });
    const file = join(companyRecordDir(item.root, item.sessionId), item.digest + ".json");
    companyWrite(file, { ...item, receipt: { url: body.url, manageUrl: body.manageUrl } });
    return new Response(null, { status: 204 });
  }});
`;
patch(backend, [
  ['import { createHash } from "node:crypto";', 'import { createHash, createHmac, timingSafeEqual } from "node:crypto";\nimport { defineTool } from "@deepseek-ai/dsh-tools";\nimport { appendPluginRecord } from "@deepseek-ai/dsh-session";\nimport { companyDesignSystemEditorUrl, registerCompanyDesignSystemEditor } from "./p7-design-system-editor.mjs";'],
  ['renameSync, rmSync, statSync, writeFileSync } from "node:fs";', 'renameSync, rmSync, statSync, realpathSync, writeFileSync } from "node:fs";'],
  ['import { basename, dirname, join, parse } from "node:path";', 'import { basename, dirname, join, parse, relative, sep } from "node:path";'],
  ["function registerRoutes(routes, host, opened) {", companySupport + "\nfunction registerRoutes(routes, host, opened) {\n  registerCompanyDesignSystemEditor(routes, { findArtifact, listArtifacts: () => listArtifacts(() => true) });" + exportRoute],
  ['        const { url, reused, remote } = await runOpen(node, script, root, remoteHostOf(request.headers));', String.raw`        if (record.skill === "claude-design-system") {
          const url = companyDesignSystemEditorUrl(root);
          if (!url) return json({ error: "此作品的 HTTPS 编辑入口当前不可用" }, 409);
          const again = recordOpened(record.skill, record.plugin, record.sessionId, root);
          opened(again, script);
          return json({ url, reused: true, sessionId: again.sessionId, title: again.title });
        }
        const { url, reused, remote } = await runOpen(node, script, root, remoteHostOf(request.headers));`],
  ["function start(ctx, node) {", "function start(ctx, node) {\n  registerCompanyEditorOutput(ctx);\n  registerCompanyFinalization(ctx);"],
]);
patch(dataBackend, [[
  "  if (skill.comments && watched) {",
  String.raw`  lines.push(
    "",
    "### Delivering the finished dashboard in a company Workspace",
    "Use the foreground open command to register this dashboard. After all edits and checks are done, call",
    "finalize_company_data_artifact with the exact root returned by open, then finish your response.",
    "Use it only on finished deliverables that the user wants to publish. Keep loopback addresses out of all user-facing progress and replies, including editing or preview links.",
    "After the turn completes, the conversation shows the real link when the private company Results Portal has published it.",
    "Report the finalization tool's result as pending publication. Only a successful Results Portal receipt establishes that the dashboard has been published."
  );
  if (skill.comments && watched) {`,
]]);

const menuItem = 'item("copy", ICON.link, t("action.copy"), "C"),';
const switchLine = 'else if (what === "copy") copyLink(actionsFor);';
const publish = String.raw`
      let pendingCompanyPublish = false;
      const publishCompany = async (view) => {
        if (pendingCompanyPublish) return toast("已有一项发布等待飞书登录");
        const popup = window.open("about:blank", "_blank");
        if (!popup) return toast("请允许 DSH 打开成果站窗口", "error");
        popup.opener = null; pendingCompanyPublish = true;
        try {
          const source = await fetch(route2("/api/p7/artifacts/export") + "?" + new URLSearchParams({ root: view.root }), { cache: "no-store" });
          if (!source.ok) throw new Error((await source.json()).error || "无法导出看板");
          const html = await source.arrayBuffer();
          const publish = () => fetch("https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/api/publish", { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: html });
          let response = await publish();
          if (response.status === 401) {
            popup.location.replace("https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/publish-login");
            toast("请在成果站完成飞书登录，登录后会继续发布");
            const deadline = Date.now() + 5 * 60 * 1000;
            while (Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 2500));
              const session = await fetch("https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/api/publish-session", { credentials: "include" });
              if (session.status === 401) continue;
              if (session.status !== 204) throw new Error("飞书账号暂时无法发布");
              response = await publish(); break;
            }
            if (response.status === 401) throw new Error("飞书发布登录已超时，请重试");
          }
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || "发布失败");
          if (typeof payload.manageUrl !== "string" || !payload.manageUrl.startsWith("https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/pub-")) throw new Error("成果站返回了无效地址");
          if (!popup.closed) { try { popup.location.replace(payload.manageUrl); } catch {} }
          toast("已发布到公司成果站", "info", undefined, payload.manageUrl);
        } catch (error) { popup.close(); toast(error.message || "无法连接公司成果站", "error"); }
        finally { pendingCompanyPublish = false; }
      };
`;
const companyConversationClient = String.raw`
  const companyCardKind = "p7-data-artifact";
  const companyCardDefinition = {
    kind: companyCardKind,
    match(event) {
      if (event.type !== "plugin:p7-artifacts/finalized" || event.ignorable !== true) return null;
      const data = event.data;
      if (!Number.isSafeInteger(data?.turn) || data.turn < 0 || typeof data.root !== "string" || typeof data.sessionId !== "string") return null;
      return { id: String(data.turn), role: "start" };
    },
    start: (_context, match) => [match.event.data],
    update({ state }, match) {
      const data = match.event.data;
      return state.some((item) => item.root === data.root && item.sessionId === data.sessionId && item.digest === data.digest)
        ? state : [...state, data];
    },
    publication: () => "immediate",
    buildLocationData({ state }, scope, previous) {
      if (scope !== "turn" || !state?.length) return null;
      // The finalization event arrives after turn/end; its payload identifies the completed turn.
      return previous?.value === state ? previous : { kind: "turn", turn: state[0].turn, key: companyCardKind, value: state };
    },
  };
  const companyActive = new Map();
  const companyLinkBase = "https://artifact.zxrc.com.cn:8010/dsh/approval-demo/artifacts/";
  function approvedCompanyLinks(value) {
    const { url, manageUrl } = value ?? {};
    if (typeof url !== "string" || !url.startsWith(companyLinkBase) || !/^pub-[a-f0-9]{32}$/.test(url.slice(companyLinkBase.length)) || manageUrl !== url + "/manage") throw new Error("成果站返回了无效的链接");
    return { url, manageUrl };
  }
  function runCompanyPublish({ root, sessionId, digest }) {
    const key = JSON.stringify([root, sessionId, digest]);
    if (companyActive.has(key)) return companyActive.get(key);
    const publish = async () => {
      const params = new URLSearchParams({ root, sessionId, digest });
      const options = { credentials: "same-origin", cache: "no-store", redirect: "error" };
      const status = await fetch(route2("/api/p7/artifacts/auto-status") + "?" + params, options);
      if (!status.ok) throw new Error("无法读取看板发布状态（" + status.status + "）");
      const saved = await status.json();
      if (saved.state === "published") return approvedCompanyLinks(saved);
      if (saved.state !== "ready") throw new Error("看板尚未定稿");
      const response = await fetch(route2("/api/p7/artifacts/auto-publish"), {
        ...options, method: "POST", headers: { "Content-Type": "application/json", "X-P7-Artifact-Digest": digest }, body: JSON.stringify({ root, sessionId }),
      });
      // The controller sends 201 only after the workspace has accepted the signed receipt.
      if (response.status !== 201) throw new Error(response.status === 401 ? "请重新登录公司 Workspace" : "成果站发布失败（" + response.status + "）");
      return approvedCompanyLinks(await response.json());
    };
    const task = (navigator.locks?.request ? navigator.locks.request("p7-data-publish:" + key, publish) : publish()).finally(() => companyActive.delete(key));
    companyActive.set(key, task);
    return task;
  }
  function CompanyArtifactCard({ data }) {
    const { root, sessionId, digest, error, title } = data;
    const [attempt, retry] = (0, import_react3.useState)(0);
    const [state, setState] = (0, import_react3.useState)({});
    (0, import_react3.useEffect)(() => {
      if (error || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return;
      let current = true;
      setState({});
      runCompanyPublish({ root, sessionId, digest }).then(
        (links) => { if (current) setState(links); },
        (failure) => { if (current) setState({ error: failure.message || "无法连接成果站" }); }
      );
      return () => { current = false; };
    }, [root, sessionId, digest, attempt, error]);
    const failure = error || state.error;
    if (failure) return (0, import_jsx_runtime3.jsxs)("div", { role: "status", children: [
      (0, import_jsx_runtime3.jsx)("span", { children: title + "：" + failure }),
      state.error && !error ? (0, import_jsx_runtime3.jsx)("button", { type: "button", onClick: () => retry((value) => value + 1), children: "重试发布" }) : null,
    ] });
    if (!state.url) return null;
    return (0, import_jsx_runtime3.jsxs)("div", { role: "status", "data-p7-artifact-publication": "published", style: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "0.75rem", rowGap: "0.5rem", padding: "0.75rem 1rem", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "0.75rem", overflowWrap: "anywhere" }, children: [
      (0, import_jsx_runtime3.jsx)("strong", { children: title }),
      (0, import_jsx_runtime3.jsx)("a", { href: state.url, target: "_blank", rel: "noopener noreferrer", style: { color: "inherit", textDecoration: "underline" }, children: "打开成果 · 分享链接" }),
      (0, import_jsx_runtime3.jsx)("a", { href: state.manageUrl, target: "_blank", rel: "noopener noreferrer", style: { color: "inherit", textDecoration: "underline" }, children: "管理查看权限" }),
    ] });
  }
  function CompanyArtifactFooter({ turn, companySession }) {
    const source = turn.data.source(companyCardKind);
    const revisions = (0, import_react3.useSyncExternalStore)(source.subscribe, source.getSnapshot, source.getSnapshot);
    return revisions?.filter((data) => data.sessionId === companySession).map((data) =>
      (0, import_jsx_runtime3.jsx)(CompanyArtifactCard, { data }, JSON.stringify([data.root, data.digest]))
    ) ?? null;
  }
  function registerCompanyCard(ctx) {
    ctx.uiConversation.events.register(companyCardDefinition);
    ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
      name: "conversation.chat.turnTail", id: companyCardKind, inject: (sessionId) => ({ companySession: String(sessionId) }),
    }, CompanyArtifactFooter));
  }
`;
patch(client, [
  ['function apply(ctx) {', companyConversationClient + '\nfunction apply(ctx) {\n  registerCompanyCard(ctx);'],
  ['const open = (view) => {', `const open = (view) => {
        if (view.skill === "claude-data") {
          window.open(route2("/api/p7/artifacts/export") + "?" + new URLSearchParams({ root: view.root, preview: "1" }), "_blank", "noopener,noreferrer");
          return;
        }`],
  [menuItem, menuItem + '\n        view.skill === "claude-data" && item("company-publish", ICON.link, "发布到公司成果站"),'],
  [switchLine, switchLine + '\n                  else if (what === "company-publish") publishCompany(actionsFor);'],
  ['pin, rename, copyLink, remove, undo,', 'pin, rename, copyLink, publishCompany, remove, undo,'],
  ['const copyLink = (view) => {', publish + 'const copyLink = (view) => {'],
  ['          copyLink,', '          copyLink,\n                  publishCompany,'],
  ['const toast = (message, kind = "info", undo2) =>', 'const toast = (message, kind = "info", undo2, link) =>'],
  ['...undo2 ? { undo: undo2 } : {}', '...undo2 ? { undo: undo2 } : {}, link'],
  ['    toast.undo &&', '    toast.link && (0, import_jsx_runtime2.jsx)("a", { href: toast.link, target: "_blank", rel: "noopener noreferrer", children: "管理查看权限" }),\n        toast.undo &&']
]);
