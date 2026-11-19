import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STATIC = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 8199;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(STATIC, rel);
  if (file.startsWith(STATIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    const data = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
    return;
  }
  const index = path.join(STATIC, "index.html");
  if (fs.existsSync(index)) {
    const data = fs.readFileSync(index);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("internal error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`video-editor listening on ${PORT}`);
});
