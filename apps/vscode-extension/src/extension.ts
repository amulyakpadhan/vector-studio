import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createConnector,
  embedText,
  type ConnectionConfig,
  type EmbeddingConfig,
} from "@vyn/core";

/**
 * Extension entry point.
 *
 * Architecture:
 *   Webview (the real React studio, sandboxed)
 *        │  postMessage RPC
 *        ▼
 *   Extension host (this file, Node)  ──native fetch──▶  your vector DB / embedder
 *
 * The webview never makes a network request. It sends typed RPC messages; the
 * host runs the shared `@vyn/core` connectors over Node's native `fetch`. No
 * CORS, no local bridge, no Tauri IPC — the whole class of transport problems
 * the web and desktop builds fought with is absent.
 */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("vyn.open", () => openPanel(context)),
  );
}

export function deactivate() {
  /* nothing to clean up */
}

let panel: vscode.WebviewPanel | undefined;

function openPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }

  const uiRoot = vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist");

  panel = vscode.window.createWebviewPanel(
    "vynStudio",
    "Vyn Studio",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [uiRoot],
    },
  );

  panel.webview.html = renderHtml(panel.webview, uiRoot);

  panel.webview.onDidReceiveMessage(
    (msg) => handleRpc(panel!, msg),
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });
}

// ─── HTML shell ──────────────────────────────────────────────────────────────

/**
 * Serves the Vite build. Vite is configured (webview-ui/vite.config.ts) to emit
 * predictable, unhashed asset names and a single JS bundle, so we can point a
 * nonce'd script tag and a stylesheet link at them through `asWebviewUri`.
 */
function renderHtml(webview: vscode.Webview, uiRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, "assets", "index.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, "assets", "index.css"));
  const styleExists = fs.existsSync(path.join(uiRoot.fsPath, "assets", "index.css"));
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    // three.js may spin up worker/blob URLs; allow them for the projection view.
    `worker-src blob:`,
    `connect-src 'none'`,
  ].join("; ");

  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${styleExists ? `<link rel="stylesheet" href="${styleUri}" />` : ""}
<title>Vyn Studio</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── RPC bridge ──────────────────────────────────────────────────────────────

type RpcRequest =
  | { type: "rpc"; id: number; kind: "connector"; method: string; config: ConnectionConfig; args?: unknown[] }
  | { type: "rpc"; id: number; kind: "embed"; config: EmbeddingConfig; text: string };

/** Connector methods the webview may invoke. Sync/no-network ones (capabilities,
 *  config) are resolved locally in the webview and never reach here. */
const ALLOWED = new Set([
  "testConnection",
  "getMeta",
  "listCollections",
  "getSchema",
  "getStats",
  "createCollection",
  "deleteCollection",
  "listRecords",
  "getRecord",
  "upsertRecords",
  "updatePayload",
  "deleteRecords",
  "vectorSearch",
  "textSearch",
  "fetchVectors",
]);

async function handleRpc(target: vscode.WebviewPanel, raw: unknown) {
  if (!isRpcRequest(raw)) return;
  const reply = (payload: Record<string, unknown>) =>
    target.webview.postMessage({ type: "rpc-result", id: raw.id, ...payload });

  try {
    if (raw.kind === "embed") {
      const vector = await embedText(raw.config, raw.text);
      reply({ ok: true, data: vector });
      return;
    }

    // kind === "connector"
    if (!ALLOWED.has(raw.method)) {
      reply({ ok: false, error: `Method "${raw.method}" is not allowed` });
      return;
    }
    const connector = createConnector(raw.config);
    const fn = (connector as unknown as Record<string, unknown>)[raw.method];
    if (typeof fn !== "function") {
      reply({ ok: false, error: `Connector has no method "${raw.method}"` });
      return;
    }
    const data = await (fn as (...a: unknown[]) => Promise<unknown>).apply(connector, raw.args ?? []);
    reply({ ok: true, data });
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function isRpcRequest(x: unknown): x is RpcRequest {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.type === "rpc" && typeof o.id === "number" && (o.kind === "connector" || o.kind === "embed");
}
