import { listProjects, readSnippet, runSnippet } from './snippet-runner.ts';

try {
  const [requestedProject, snippetName = 'test.php', ...extraArgs] = process.argv.slice(2);
  const projects = listProjects();
  const project = requestedProject ?? (projects.length === 1 ? projects[0] : undefined);

  if (!project || !projects.includes(project) || extraArgs.length > 0) {
    throw new Error(
      `Usage: node run-snippet.ts <project> [snippet.php]\nAvailable projects: ${projects.join(', ') || '(none)'}`,
    );
  }

  const result = await runSnippet(project, readSnippet(project, snippetName));
  if (result.exitCode !== 0) {
    const status = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
    const details = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
    throw new Error([`PHP failed (${status})`, details].filter(Boolean).join('\n'));
  }

  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
