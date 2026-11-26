import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { Message, RequestMessage, ResponseMessage } from 'vscode-jsonrpc';
import { WebSocket, WebSocketServer } from 'ws';
import { listProjects, listSnippets, projectFileUri, projectIncludePaths } from './snippet-runner.ts';

const require = createRequire(import.meta.url);

function connectLanguageServer(socket: WebSocket) {
  const projects = listProjects().map((name) => ({
    name,
    uri: projectFileUri(name),
    includePaths: projectIncludePaths(name),
  }));
  const workspaceFolders = projects.map(({ name, uri }) => ({ name, uri }));
  const snippetUris = new Map(projects.flatMap(({ name }) => listSnippets(name).map((file) => {
    const uri = projectFileUri(name, file);
    return [uri.toLowerCase(), uri] as const;
  })));
  const binary = require.resolve('intelephense');
  const storagePath = mkdtempSync(join(tmpdir(), 'php-snippets-lsp-'));

  const child = spawn(process.execPath, [binary, '--stdio']);
  const reader = new StreamMessageReader(child.stdout);
  const writer = new StreamMessageWriter(child.stdin);

  const send = (message: Message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const close = () => socket.close(1011, 'PHP language server stopped');
  const write = (message: Message | ResponseMessage) => { void writer.write(message).catch(close); };

  reader.listen((message) => {
    if (!('method' in message && 'id' in message)) return send(message);

    const request = message as RequestMessage;
    if (request.method === 'workspace/configuration') {
      const { items } = request.params as { items: { scopeUri?: string; section?: string }[] };
      const result = items.map(({ scopeUri, section }) => {
        const project = projects.find(({ uri }) => scopeUri === uri || scopeUri?.startsWith(`${uri}/`))
          ?? (projects.length === 1 ? projects[0] : undefined);
        const settings = { intelephense: { environment: { includePaths: project?.includePaths ?? [] } } };
        return (section?.split('.') ?? []).reduce<unknown>((value, key) =>
          (value as Record<string, unknown> | undefined)?.[key], settings) ?? null;
      });
      return write({ jsonrpc: '2.0', id: request.id, result });
    }

    if (request.method === 'workspace/workspaceFolders') {
      return write({ jsonrpc: '2.0', id: request.id, result: workspaceFolders });
    }

    send(message);
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) return socket.close(1003, 'Expected JSON text');

    let message: Message;
    try {
      message = JSON.parse(data.toString()) as Message;
      if (message?.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC message');
    } catch {
      return socket.close(1007, 'Invalid JSON-RPC message');
    }

    const request = 'method' in message ? message as RequestMessage : undefined;
    const params = request?.params as {
      capabilities?: { workspace?: Record<string, unknown> };
      textDocument?: { uri?: string };
    } | undefined;
    if (request?.method === 'initialize') {
      message = {
        ...request,
        params: {
          ...params,
          rootUri: workspaceFolders[0]?.uri ?? null,
          workspaceFolders,
          initializationOptions: { storagePath, globalStoragePath: storagePath },
          capabilities: {
            ...params?.capabilities,
            workspace: { ...params?.capabilities?.workspace, configuration: true, workspaceFolders: true },
          },
        },
      } as RequestMessage;
    } else if (typeof params?.textDocument?.uri === 'string' && params.textDocument.uri.startsWith('file:')) {
      // Monaco can lowercase document notifications while using the original URI for requests.
      const documentUrl = URL.parse(params.textDocument.uri);
      const uri = documentUrl && snippetUris.get(documentUrl.href.toLowerCase());
      if (uri) params.textDocument.uri = uri;
    }
    write(message);
  });

  socket.once('close', () => child.kill());
  socket.on('error', () => child.kill());
  child.on('error', close);
  reader.onError(close);
  writer.onError(close);
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('close', () => {
    close();
    reader.dispose();
    writer.dispose();
    void rm(storagePath, { recursive: true, force: true }).catch(console.error);
  });
}

export function attachPhpLanguageServer(server: Server, host: string) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/php-language-server') return;
    const authority = `${host}:${request.socket.localPort}`;
    if (request.headers.host !== authority || request.headers.origin !== `http://${authority}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on('error', console.error);
      try {
        connectLanguageServer(client);
      } catch (error) {
        console.error(error);
        client.close(1011, 'Could not start PHP language server');
      }
    });
  });
}
