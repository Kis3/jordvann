// Lokal utviklingsserver uten avhengigheter: statiske filer + api/*.js med
// samme handler-signatur som Vercel (req.query, res.status().send()).
// Kjør: node dev-server.mjs  →  http://localhost:3456
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROT  = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3456;
const TYPER = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.status = code => { res.statusCode = code; return res; };
  res.send   = body => res.end(body);

  const api = url.pathname.match(/^\/api\/([a-z0-9-]+)$/i);
  if (api) {
    try {
      const mod = await import(pathToFileURL(path.join(ROT, 'api', api[1] + '.js')).href);
      req.query = Object.fromEntries(url.searchParams);
      // Siden åpnet som fil (file://) har origin «null» – tillat det bare lokalt
      if (req.headers.origin === 'null') res.setHeader('Access-Control-Allow-Origin', 'null');
      await mod.default(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(404).send('Ukjent API: ' + api[1]);
    }
    return;
  }

  const fil = path.normalize(path.join(ROT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!fil.startsWith(ROT) || fil.includes(`${path.sep}api${path.sep}`)) return res.status(403).send('Forbudt');
  try {
    const data = await readFile(fil);
    res.setHeader('Content-Type', TYPER[path.extname(fil)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch {
    res.status(404).send('Ikke funnet');
  }
}).listen(PORT, () => console.log(`Skredvarsel Fv 609: http://localhost:${PORT}`));
