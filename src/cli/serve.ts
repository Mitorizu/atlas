import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Serves the built viewer plus one artefact (DESIGN.md §5).
 *
 * A plain static server rather than vite: `atlas` must work from any directory, on a
 * machine that has never seen this repo's dev tooling. The bundle is built once
 * (`npm run build:web`); this only hands out files.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

export interface ServeOptions {
  /** Directory holding the built viewer (index.html and assets/). */
  bundleDir: string;
  /** Artefact to serve at /graph.json, overriding anything in the bundle. */
  artifactPath: string;
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  const bundleDir = resolve(options.bundleDir);
  const artifactPath = resolve(options.artifactPath);
  const host = options.host ?? '127.0.0.1';

  if (!existsSync(join(bundleDir, 'index.html'))) {
    throw new Error(`viewer bundle not found at ${bundleDir}. Build it with: npm run build:web`);
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      // The artefact is served from wherever the caller put it, not from the bundle.
      if (pathname === '/graph.json') {
        try {
          const body = await readFile(artifactPath);
          response.writeHead(200, { 'content-type': CONTENT_TYPES['.json']! }).end(body);
        } catch {
          response.writeHead(404).end('no artifact');
        }
        return;
      }

      // Everything else comes from the bundle; `normalize` keeps `..` inside it.
      const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      let target = join(bundleDir, relative === '/' ? 'index.html' : relative);
      if (!target.startsWith(bundleDir)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      try {
        if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
      } catch {
        target = join(bundleDir, 'index.html'); // SPA fallback
      }
      try {
        const body = await readFile(target);
        const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': type }).end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    })();
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return {
    url: `http://${host}:${port}/`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
