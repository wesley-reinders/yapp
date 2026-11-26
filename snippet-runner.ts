import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export function listSnippets(project: string): string[] {
  return readdirSync(join(projectsDirectory, project), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.php'))
    .map((entry) => entry.name)
    .sort();
}

export function readSnippet(project: string, name: string): string {
  if (basename(name) !== name || !name.endsWith('.php')) {
    throw new Error('Specify a PHP filename inside the project folder.');
  }

  return readFileSync(join(projectsDirectory, project, name), 'utf8');
}

export function projectFileUri(project: string, name = ''): string {
  return pathToFileURL(join(projectsDirectory, project, name)).href;
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
