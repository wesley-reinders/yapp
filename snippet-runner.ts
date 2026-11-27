import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectsDirectory = fileURLToPath(new URL('./projects/', import.meta.url));
const bootstrapFile = new URL('./runner.php', import.meta.url);

export function listProjects(): string[] {
  return readdirSync(projectsDirectory, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() && existsSync(join(projectsDirectory, entry.name, 'project.json')),
    )
    .map((entry) => entry.name)
    .sort();
}

function snippetDirectory(project: string) {
  const directory = join(projectsDirectory, project, 'snippets');
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) {
    throw new Error(`Expected a directory at projects/${project}/snippets.`);
  }
  return directory;
}

function phpFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.php'))
    .map((entry) => entry.name);
}

export function listSnippets(project: string): string[] {
  const directory = snippetDirectory(project);
  const files = existsSync(directory) ? phpFiles(directory) : [];
  return [...new Set([...files, ...phpFiles(join(projectsDirectory, project))])].sort();
}

function snippetPaths(project: string, name: string) {
  if (basename(name) !== name || !name.endsWith('.php')) {
    throw new Error('Specify a PHP snippet filename.');
  }

  return {
    current: join(snippetDirectory(project), name),
    legacy: join(projectsDirectory, project, name),
  };
}

function snippetPath(project: string, name: string): string {
  const { current, legacy } = snippetPaths(project, name);
  return lstatSync(current, { throwIfNoEntry: false })?.isFile() ? current : legacy;
}

export function readSnippet(project: string, name: string): string {
  return readFileSync(snippetPath(project, name), 'utf8');
}

export function createSnippet(project: string, file: string) {
  const directory = snippetDirectory(project);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  const code = '<?php\n\n';
  writeFileSync(path, code, { flag: 'wx' });
  return { file, code, uri: pathToFileURL(path).href };
}

export function saveSnippet(project: string, file: string, code: string) {
  const mode = statSync(snippetPath(project, file)).mode;
  const directory = snippetDirectory(project);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, file);
  const pending = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(pending, code, { flag: 'wx', mode });
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function deleteSnippet(project: string, file: string) {
  const { current, legacy } = snippetPaths(project, file);
  // Remove the fallback first so a deleted snippet cannot reappear from the project root.
  for (const path of [legacy, current]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) unlinkSync(path);
  }
}

export function renameSnippet(project: string, file: string, newFile: string) {
  const source = snippetPaths(project, file);
  const target = snippetPaths(project, newFile);
  const sourcePath = snippetPath(project, file);
  const code = readFileSync(sourcePath, 'utf8');
  if (file !== newFile) {
    const moves = [[source.legacy, target.legacy], [source.current, target.current]]
      .filter(([from]) => lstatSync(from, { throwIfNoEntry: false })?.isFile());

    for (const [from, to] of moves) {
      const destination = lstatSync(to, { throwIfNoEntry: false });
      if (destination) {
        const original = lstatSync(from);
        const caseOnly = from.toLowerCase() === to.toLowerCase() &&
          original.dev === destination.dev && original.ino === destination.ino;
        if (!caseOnly) {
          throw Object.assign(new Error('A snippet with that name already exists.'), { code: 'EEXIST' });
        }
      }
    }

    const completed: string[][] = [];
    try {
      for (const [from, to] of moves) {
        renameSync(from, to);
        completed.push([from, to]);
      }
    } catch (error) {
      for (const [from, to] of completed.reverse()) renameSync(to, from);
      throw error;
    }
  }
  const newPath = sourcePath === source.current ? target.current : target.legacy;
  return { file: newFile, code, uri: pathToFileURL(newPath).href };
}

export function projectFileUri(project: string): string {
  return pathToFileURL(join(projectsDirectory, project)).href;
}

export function snippetFileUri(project: string, name: string): string {
  return pathToFileURL(snippetPath(project, name)).href;
}

function readProjectConfig(project: string): Record<string, unknown> {
  const config: unknown = JSON.parse(readFileSync(join(projectsDirectory, project, 'project.json'), 'utf8'));
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`Expected a JSON object in projects/${project}/project.json.`);
  }
  return Object.fromEntries(Object.entries(config));
}

export function projectIncludePaths(project: string): string[] {
  const { phpSource, phpInclude } = readProjectConfig(project);
  if (typeof phpSource !== 'string' || !phpSource) return [];

  const source = resolve(projectsDirectory, project, phpSource);
  const paths = Array.isArray(phpInclude) ? phpInclude : ['app', 'vendor'];
  return paths.filter((path) => typeof path === 'string')
    .map((path) => resolve(source, path))
    .filter((path) => existsSync(path));
}

export function runSnippet(project: string, snippet: string, signal?: AbortSignal) {
  const { container } = readProjectConfig(project);
  if (
    typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)
  ) {
    throw new Error(`Set a valid Docker container name or ID in projects/${project}/project.json.`);
  }

  const bootstrap = readFileSync(bootstrapFile, 'utf8');
  const snippetBody = snippet.replace(/^\uFEFF?<\?php(?=\s|$)[ \t]*(?:\r?\n)?/i, '');

  return new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', container, 'php'], { shell: false, signal });
      let stdout = '';
      let stderr = '';
      let inputError: Error | undefined;

      child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
      child.stdin.on('error', (error) => { inputError = error; });
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        if (exitCode === 0 && inputError) {
          reject(inputError);
          return;
        }
        resolve({ stdout, stderr, exitCode, signal });
      });

      child.stdin.end(`${bootstrap}\n${snippetBody}`);
    },
  );
}
