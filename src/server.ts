import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { defaultRoot } from "./content.js";
import { loadAndValidate, render, serializeRankings, type BuildManifest } from "./build.js";
import type { Content } from "./schema.js";

/**
 * A preview API over the content.
 *
 * Exists so a UI can be built against the real shapes before anything is
 * published, and so an editor can see a bad edit immediately. Two decisions
 * follow from that purpose:
 *
 *   - It re-reads and re-validates on every request. A preview server that
 *     caches is a preview server that shows you the previous version of the file
 *     you just saved.
 *   - A validation error is a 500 with the issues in the body, not an empty
 *     list. The whole point is to surface the problem while someone is looking.
 *
 * The `ETag` on every response is the content revision, so a consumer that
 * already holds a build gets a `304` instead of the whole catalog.
 */

export interface ServerOptions {
  root?: string;
  now?: () => Date;
}

export function createContentServer(options: ServerOptions = {}): Server {
  return createServer((request, response) => {
    void handle(request, response, options).catch((error: unknown) => {
      sendJson(response, 500, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
}

export interface StartedContentServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export async function startContentServer(
  options: ServerOptions & { port?: number; host?: string } = {},
): Promise<StartedContentServer> {
  const port = options.port ?? Number(process.env.PORT ?? 8790);
  const host = options.host ?? "127.0.0.1";
  const server = createContentServer(options);

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  return {
    url: `http://${host}:${port}`,
    server,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "if-none-match",
    });
    response.end();
    return;
  }

  if (method !== "GET") {
    sendJson(response, 405, { error: { message: `${method} is not supported` } });
    return;
  }

  if (path === "/health") {
    sendJson(response, 200, { ok: true, service: "cokey-cms" });
    return;
  }

  const root = options.root ?? defaultRoot();
  const { report } = await loadAndValidate(root, options.now?.() ?? new Date());

  if (!report.content) {
    // A preview server's most useful response to a broken edit is the reason.
    sendJson(response, 500, {
      error: {
        message: `${report.errors} validation error(s) — fix these before the content can be served`,
        type: "content_invalid",
      },
      issues: report.issues,
    });
    return;
  }

  const { manifest, files } = render(report.content, options.now?.() ?? new Date());
  const etag = `"${manifest.revision}"`;

  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag });
    response.end();
    return;
  }

  const body = route(path, report.content, manifest, files);
  if (body === undefined) {
    sendJson(response, 404, {
      error: {
        message: `No content endpoint for ${path}`,
        type: "not_found",
        available: [
          "/api/index",
          "/api/providers",
          "/api/providers/:id",
          "/api/models",
          "/api/terms",
          "/api/rankings",
        ],
      },
    });
    return;
  }

  sendJson(response, 200, body, { etag, "cache-control": "no-store" });
}

function route(
  path: string,
  content: Content,
  manifest: BuildManifest,
  files: Record<string, unknown>,
): unknown {
  if (path === "/api/index" || path === "/") return manifest;
  if (path === "/api/providers") return files["providers.json"];
  if (path === "/api/models") return files["models.json"];
  if (path === "/api/terms") return files["terms.json"];
  if (path === "/api/rankings") return serializeRankings(content.rankings);

  const providerMatch = /^\/api\/providers\/([a-z0-9-]+)$/.exec(path);
  if (providerMatch) {
    const id = providerMatch[1]!;
    return content.providers.find((provider) => provider.id === id);
  }

  return undefined;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}
