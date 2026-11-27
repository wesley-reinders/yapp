import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSnippet, deleteSnippet, listProjects, listSnippets, readSnippet, renameSnippet, runSnippet, saveSnippet, snippetFileUri } from './snippet-runner.ts';
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
    return json(response, 200, { code: readSnippet(project, file), uri: snippetFileUri(project, file) });
  }

  const isRun = request.method === 'POST' && url.pathname === '/api/run';
  const isCreate = request.method === 'POST' && url.pathname === '/api/snippet';
  const isSave = request.method === 'PUT' && url.pathname === '/api/snippet';
  const isDelete = request.method === 'DELETE' && url.pathname === '/api/snippet';
  const isRename = request.method === 'PATCH' && url.pathname === '/api/snippet';
  if (isRun || isCreate || isSave || isDelete || isRename) {
    const operation = isRun ? 'Run' : 'Snippet';
    if (request.headers.origin !== `http://${authority}` || request.headers['content-type'] !== 'application/json') {
      return json(response, 403, { error: `${operation} requests must come from the local editor.` });
    }

    let body = '';
    for await (const chunk of request.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
      body += chunk;
      if (Buffer.byteLength(body) > 128 * 1024) {
        request.resume();
        return json(response, 413, { error: `${operation} requests must be smaller than 128 KB.` });
      }
    }

    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return json(response, 400, { error: 'Invalid JSON.' });
    }
    const invalidInput = isRun ? 'Select a configured project and provide PHP code.' : 'Select a configured project.';
    if (typeof input !== 'object' || input === null || !('project' in input) ||
        typeof input.project !== 'string' || !projects.includes(input.project)) {
      return json(response, 400, { error: invalidInput });
    }
    const project = input.project;

    if (isCreate || isRename) {
      const files = listSnippets(project);
      const original = isRename && 'file' in input && typeof input.file === 'string' ? input.file : '';
      if (isRename && !files.includes(original)) {
        return json(response, 404, { error: 'Snippet not found.' });
      }
      const proposedName = isRename ? ('name' in input ? input.name : null) : ('file' in input ? input.file : null);
      const name = typeof proposedName === 'string' ? proposedName.trim() : '';
      const file = name.replace(/\.php$/i, '') + '.php';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}\.php$/.test(file)) {
        return json(response, 400, { error: 'Use 1–120 letters, digits, hyphens, or underscores, starting with a letter or digit.' });
      }
      const conflict = () => json(response, 409, { error: 'A snippet with that name already exists.' });
      if (files.some((existing) => existing !== original && existing.toLowerCase() === file.toLowerCase())) {
        return conflict();
      }
      try {
        if (isRename) return json(response, 200, renameSnippet(project, original, file));
        return json(response, 201, createSnippet(project, file));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return conflict();
        throw error;
      }
    }

    if (isSave || isDelete) {
      if (!('file' in input) || typeof input.file !== 'string' || !listSnippets(project).includes(input.file)) {
        return json(response, 404, { error: 'Snippet not found.' });
      }
      if (isDelete) {
        deleteSnippet(project, input.file);
        return json(response, 200, {});
      }
      if (!('code' in input) || typeof input.code !== 'string') {
        return json(response, 400, { error: 'Provide PHP code.' });
      }
      saveSnippet(project, input.file, input.code);
      return json(response, 200, {});
    }

    if (!('code' in input) || typeof input.code !== 'string') {
      return json(response, 400, { error: invalidInput });
    }
    const timeout = AbortSignal.timeout(30_000);
    try {
      return json(response, 200, await runSnippet(project, input.code, timeout));
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
