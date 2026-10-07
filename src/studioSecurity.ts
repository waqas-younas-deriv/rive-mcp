import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function studioSecurity(port: number) {
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("base64");
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const cookieName = `rive_session_${port}`;
  const matches = (value: string | undefined) => {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const bootstrap = `<!doctype html><meta charset="utf-8"><title>Rive Studio</title><p id="status">Opening private Studio session…</p><script nonce="${nonce}">
    const token = location.hash.slice(1);
    history.replaceState(null, '', '/');
    if (!/^[a-f0-9]{64}$/.test(token)) document.getElementById('status').textContent = 'Open the private Studio link returned by riv_studio.';
    else fetch('/session', {method: 'POST', headers: {Authorization: 'Bearer ' + token}})
      .then(r => { if (!r.ok) throw Error(); location.replace('/'); })
      .catch(() => { document.getElementById('status').textContent = 'Session expired. Open a new Studio link.'; });
  </script>`;
  return {
    url: `${origin}/#${token}`,
    nonce,
    authorize(req: IncomingMessage, res: ServerResponse): boolean {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      const reject = (status: number, message: string) => { res.writeHead(status, { "Content-Type": "text/plain" }); res.end(message); return false; };
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) return reject(400, "Invalid request target.");
      if (req.headers.host !== host) return reject(403, "Invalid Host.");
      if (req.headers.origin && req.headers.origin !== origin) return reject(403, "Cross-origin request denied.");
      if (req.headers["sec-fetch-site"] === "cross-site") return reject(403, "Cross-site request denied.");
      const bearer = req.headers.authorization?.startsWith("Bearer ") === true && matches(req.headers.authorization.slice(7));
      const cookie = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const authenticated = bearer || matches(cookie);
      if (req.url === "/session" && req.method === "POST") {
        if (!bearer) return reject(401, "Private Studio link required.");
        res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(204); res.end(); return false;
      }
      if (req.url === "/" && req.method === "GET" && !authenticated) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(bootstrap); return false;
      }
      if (!authenticated) return reject(401, "Authentication required.");
      if (req.method !== "GET" && req.method !== "POST") return reject(405, "Method not allowed.");
      // Non-browser clients must use a bearer token; cookies alone are not a CSRF credential.
      if (req.method === "POST" && !bearer && req.headers.origin !== origin) return reject(403, "Same-origin POST required.");
      return true;
    },
  };
}
