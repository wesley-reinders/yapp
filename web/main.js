import * as monaco from 'monaco-editor/editor/editor.main.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import AnsiToHtml from 'ansi-to-html';
import './style.css';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme('snippet-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#141920',
    'editorLineNumber.foreground': '#828e9e',
    'editor.lineHighlightBackground': '#1b232d',
    'editorIndentGuide.background1': '#2d3847',
    'editor.selectionBackground': '#324b61',
  },
});

const editor = monaco.editor.create(document.querySelector('#editor'), {
  model: null,
  theme: 'snippet-dark',
  automaticLayout: true,
  ariaLabel: 'PHP snippet editor',
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 14,
  lineHeight: 24,
  minimap: { enabled: false },
  padding: { top: 14 },
  scrollBeyondLastLine: false,
  tabSize: 4,
});

const projectSelect = document.querySelector('#project');
const snippetSelect = document.querySelector('#snippet');
const runButton = document.querySelector('#run');
const clearButton = document.querySelector('#clear');
const status = document.querySelector('#status');
const phpStatus = document.querySelector('#php-status');
const output = document.querySelector('#output');
const models = new Map();
let projects = [];
let busy = false;

if (/Mac/.test(navigator.platform)) document.querySelector('#shortcut').textContent = '⌘ ↵';

const languageServer = new WebSocket(`ws://${location.host}/php-language-server`);
languageServer.addEventListener('open', () => {
  const transport = monaco.lsp.WebSocketTransport.fromWebSocket(languageServer);
  new monaco.lsp.MonacoLspClient(transport);
  phpStatus.textContent = 'Indexing PHP…';
});
languageServer.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'window/logMessage' && message.params.message.startsWith('Indexer: Indexing finished.')) {
    phpStatus.textContent = 'PHP IntelliSense';
  }
});
languageServer.addEventListener('close', () => {
  phpStatus.textContent = 'PHP IntelliSense offline';
});

async function request(path, options) {
  const response = await fetch(`/api/${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function updateControls() {
  projectSelect.disabled = busy || projects.length === 0;
  snippetSelect.disabled = busy || snippetSelect.options.length === 0;
  runButton.disabled = busy || !editor.getModel();
}

function setStatus(label, state = '') {
  status.textContent = label;
  status.dataset.state = state;
}

function showOutput(text, label, state = '') {
  setStatus(label, state);
  const content = document.createElement('pre');
  if (text) {
    const converter = new AnsiToHtml({ escapeXML: true, fg: '#dbe4ec', bg: '#11161b' });
    content.innerHTML = converter.toHtml(text);
  } else {
    content.className = 'placeholder';
    content.textContent = 'The snippet produced no output.';
  }
  output.replaceChildren(content);
  output.scrollTop = 0;
  clearButton.disabled = false;
}

function clearOutput() {
  const placeholder = document.createElement('p');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Run a snippet to see its output here.';
  output.replaceChildren(placeholder);
  setStatus('Ready');
  clearButton.disabled = true;
}

async function loadSnippet() {
  busy = true;
  editor.setModel(null);
  updateControls();
  try {
    const project = projectSelect.value;
    const file = snippetSelect.value;
    if (!file) {
      showOutput('Add a PHP file to this project folder to get started.', 'No snippets');
      return;
    }

    const query = new URLSearchParams({ project, file });
    const key = query.toString();
    if (!models.has(key)) {
      const { code, uri } = await request(`snippet?${query}`);
      models.set(key, monaco.editor.createModel(code, 'php', monaco.Uri.parse(uri)));
    }
    editor.setModel(models.get(key));
    clearOutput();
  } catch (error) {
    showOutput(error.message, 'Load failed', 'error');
  } finally {
    busy = false;
    updateControls();
  }
}

async function selectProject() {
  const project = projects.find(({ name }) => name === projectSelect.value);
  const files = project.snippets;
  snippetSelect.replaceChildren(...files.map((file) => new Option(file, file)));
  if (files.includes('test.php')) snippetSelect.value = 'test.php';
  await loadSnippet();
}

async function runCurrentSnippet() {
  if (busy || !editor.getModel()) return;

  busy = true;
  updateControls();
  setStatus('Running…', 'running');
  clearButton.disabled = true;
  const running = document.createElement('p');
  running.className = 'placeholder';
  running.textContent = 'Waiting for PHP…';
  output.replaceChildren(running);

  try {
    const result = await request('run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectSelect.value, code: editor.getValue() }),
    });
    const ok = result.exitCode === 0;
    const label = ok ? 'Finished' : result.signal || `Exit ${result.exitCode}`;
    const text = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
    showOutput(text, label, ok ? 'success' : 'error');
  } catch (error) {
    showOutput(error.message, 'Run failed', 'error');
  } finally {
    busy = false;
    updateControls();
  }
}

projectSelect.addEventListener('change', selectProject);
snippetSelect.addEventListener('change', loadSnippet);
runButton.addEventListener('click', runCurrentSnippet);
clearButton.addEventListener('click', clearOutput);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCurrentSnippet);

try {
  projects = await request('projects');
  projectSelect.replaceChildren(...projects.map(({ name }) => new Option(name, name)));
  if (projects.length) {
    await selectProject();
  } else {
    showOutput('Add a project with a project.json under projects/.', 'No projects');
  }
} catch (error) {
  showOutput(error.message, 'Load failed', 'error');
}
