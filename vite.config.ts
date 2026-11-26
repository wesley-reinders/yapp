import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { listProjects, listSnippets, projectFileUri, readSnippet, runSnippet } from './snippet-runner.ts';
import { attachPhpLanguageServer } from './php-language-server.ts';

const host = '127.0.0.1';
const port = 5173;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  const authority = `${host}:${request.socket.localPort}`;
  if (request.headers.host !== authority) {
    return json(response, 403, { error: 'Open the editor at its local URL.' });
  }

  const projects = listProjects();
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    return json(response, 200, projects.map((name) => ({ name, snippets: listSnippets(name) })));
  }

  if (request.method === 'GET' && url.pathname === '/api/snippet') {
    const project = url.searchParams.get('project') ?? '';
    const file = url.searchParams.get('file') ?? '';
    if (!projects.includes(project) || !listSnippets(project).includes(file)) {
      return json(response, 404, { error: 'Snippet not found.' });
    }
    return json(response, 200, { code: readSnippet(project, file), uri: projectFileUri(project, file) });
  }

  if (request.method === 'POST' && url.pathname === '/api/run') {
    if (request.headers.origin !== `http://${authority}` || request.headers['content-type'] !== 'application/json') {
      return json(response, 403, { error: 'Run requests must come from the local editor.' });
    }

    let body = '';
    for await (const chunk of request.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
      body += chunk;
      if (Buffer.byteLength(body) > 128 * 1024) {
        request.resume();
        return json(response, 413, { error: 'Run requests must be smaller than 128 KB.' });
      }
    }

    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return json(response, 400, { error: 'Invalid JSON.' });
    }
    if (
      typeof input !== 'object' || input === null || !('project' in input) ||
      typeof input.project !== 'string' || !projects.includes(input.project) ||
      !('code' in input) || typeof input.code !== 'string'
    ) {
      return json(response, 400, { error: 'Select a configured project and provide PHP code.' });
    }

    const timeout = AbortSignal.timeout(30_000);
    try {
      return json(response, 200, await runSnippet(input.project, input.code, timeout));
    } catch (error) {
      if (timeout.aborted) return json(response, 504, { error: 'The run exceeded 30 seconds.' });
      throw error;
    }
  }

  return json(response, 404, { error: 'Unknown API route.' });
}

export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  server: { host, port, cors: false },
  plugins: [{
    name: 'snippet-api',
    configureServer(server) {
      if (server.httpServer instanceof Server) attachPhpLanguageServer(server.httpServer, host);
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', `http://${host}`);
        if (!url.pathname.startsWith('/api/')) return next();

        void handleApi(request, response, url).catch((error: unknown) => {
          json(response, 500, { error: error instanceof Error ? error.message : 'The runner failed.' });
        });
      });
    },
  }],
});
