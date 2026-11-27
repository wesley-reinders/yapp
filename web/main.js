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
const manageButton = document.querySelector('#manage-snippets');
const manager = document.querySelector('#snippet-manager');
const managerProject = document.querySelector('#manager-project');
const managerList = document.querySelector('#manager-list');
const managerEmpty = document.querySelector('#manager-empty');
const managerStatus = document.querySelector('#manager-status');
const snippetRow = document.querySelector('#snippet-row');
const newButton = document.querySelector('#new-snippet');
const saveButton = document.querySelector('#save-snippet');
const newDialog = document.querySelector('#new-snippet-dialog');
const nameDialogTitle = document.querySelector('#new-snippet-title');
const newForm = document.querySelector('#new-snippet-form');
const nameInput = document.querySelector('#snippet-name');
const newError = document.querySelector('#new-snippet-error');
const cancelButton = document.querySelector('#cancel-snippet');
const createButton = document.querySelector('#create-snippet');
const deleteDialog = document.querySelector('#delete-snippet-dialog');
const deleteForm = document.querySelector('#delete-snippet-form');
const deleteMessage = document.querySelector('#delete-snippet-message');
const deleteError = document.querySelector('#delete-snippet-error');
const cancelDelete = document.querySelector('#cancel-delete');
const confirmDelete = document.querySelector('#confirm-delete');
const runButton = document.querySelector('#run');
const clearButton = document.querySelector('#clear');
const status = document.querySelector('#status');
const phpStatus = document.querySelector('#php-status');
const output = document.querySelector('#output');
const models = new Map();
const savedVersions = new WeakMap();
const favoritesStorageKey = 'yapp.snippetFavorites';
const favorites = readFavorites();
let projects = [];
let busy = false;
let fileToDelete;
let fileToRename;

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
  const model = editor.getModel();
  projectSelect.disabled = busy || projects.length === 0;
  snippetSelect.disabled = busy || snippetSelect.options.length === 0;
  manageButton.disabled = busy || !projectSelect.value;
  saveButton.disabled = busy || !model || model.getAlternativeVersionId() === savedVersions.get(model);
  runButton.disabled = busy || !model;
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

function cacheSnippet(key, { code, uri }) {
  const model = monaco.editor.createModel(code, 'php', monaco.Uri.parse(uri));
  models.set(key, model);
  savedVersions.set(model, model.getAlternativeVersionId());
  return model;
}

async function loadSnippet() {
  busy = true;
  editor.setModel(null);
  updateControls();
  try {
    const project = projectSelect.value;
    const file = snippetSelect.value;
    if (!file) {
      showOutput('Open Manage snippets to create your first snippet.', 'No snippets');
      return;
    }

    const query = new URLSearchParams({ project, file });
    const key = query.toString();
    const model = models.get(key);
    if (model) editor.setModel(model);
    else editor.setModel(cacheSnippet(key, await request(`snippet?${query}`)));
    clearOutput();
  } catch (error) {
    showOutput(error.message, 'Load failed', 'error');
  } finally {
    busy = false;
    updateControls();
  }
}

function readFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(favoritesStorageKey) ?? '[]');
    if (Array.isArray(stored)) return new Set(stored.filter((key) => typeof key === 'string'));
  } catch {
    // The manager can still use favorites for this session.
  }
  return new Set();
}

function updateFavorite(key, favorite) {
  if (favorite) favorites.add(key);
  else favorites.delete(key);
  persistFavorites();
}

function persistFavorites() {
  managerStatus.textContent = '';
  try {
    localStorage.setItem(favoritesStorageKey, JSON.stringify([...favorites]));
  } catch {
    managerStatus.textContent = 'Favorite changes are available for this session.';
  }
}

function snippetKey(project, file) {
  return new URLSearchParams({ project, file }).toString();
}

function snippetName(file) {
  return file.replace(/\.php$/, '');
}

function selectedProject() {
  return projects.find(({ name }) => name === projectSelect.value);
}

function sortedSnippets(project) {
  const starred = [];
  const remaining = [];
  for (const file of project.snippets) {
    const group = favorites.has(snippetKey(project.name, file)) ? starred : remaining;
    group.push(file);
  }
  return [...starred, ...remaining];
}

function showSnippetOptions(project, selected) {
  snippetSelect.replaceChildren(...sortedSnippets(project).map((file) => new Option(snippetName(file), file)));
  if (project.snippets.includes(selected)) snippetSelect.value = selected;
}

async function selectProject() {
  const project = selectedProject();
  showSnippetOptions(project, 'test.php');
  await loadSnippet();
}

function renderManager(project, focusFile, focusAction = 'favorite') {
  managerProject.textContent = project.name;
  managerEmpty.hidden = project.snippets.length > 0;
  const selected = snippetSelect.value;
  let focusTarget;
  const rows = sortedSnippets(project).map((file) => {
    const row = snippetRow.content.firstElementChild.cloneNode(true);
    const name = snippetName(file);
    const key = snippetKey(project.name, file);
    const starred = favorites.has(key);
    const open = row.querySelector('.open-snippet');
    const favorite = row.querySelector('.favorite-snippet');
    const rename = row.querySelector('.rename-snippet');
    const remove = row.querySelector('.delete-snippet');

    open.textContent = name;
    if (file === selected) open.setAttribute('aria-current', 'true');
    open.addEventListener('click', async () => {
      if (busy) return;
      manager.close();
      snippetSelect.value = file;
      if (file !== selected || !editor.getModel()) await loadSnippet();
      if (editor.getModel()) editor.focus();
    });
    favorite.textContent = starred ? '★' : '☆';
    favorite.setAttribute('aria-label', `Favorite ${name}`);
    favorite.setAttribute('aria-pressed', String(starred));
    favorite.title = starred ? 'Remove from favorites' : 'Add to favorites';
    favorite.addEventListener('click', () => {
      updateFavorite(key, !starred);
      showSnippetOptions(project, selected);
      renderManager(project, file);
    });
    rename.setAttribute('aria-label', `Rename ${name}`);
    rename.addEventListener('click', () => promptSnippetName(file));
    if (file === focusFile) focusTarget = focusAction === 'rename' ? rename : favorite;
    remove.setAttribute('aria-label', `Delete ${name}`);
    remove.addEventListener('click', () => {
      fileToDelete = file;
      const model = models.get(key);
      const unsaved = model && model.getAlternativeVersionId() !== savedVersions.get(model);
      deleteMessage.textContent = unsaved
        ? `“${name}” and its unsaved edits will be deleted permanently.`
        : `“${name}” will be deleted permanently.`;
      deleteError.textContent = '';
      deleteDialog.showModal();
    });
    return row;
  });
  managerList.replaceChildren(...rows);
  focusTarget?.focus();
}

async function deleteCurrentSnippet(event) {
  event.preventDefault();
  if (busy || !fileToDelete) return;

  const project = selectedProject();
  const file = fileToDelete;
  const selected = snippetSelect.value;
  busy = confirmDelete.disabled = cancelDelete.disabled = true;
  deleteError.textContent = '';
  updateControls();
  try {
    await request('snippet', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: project.name, file }),
    });
  } catch (error) {
    deleteError.textContent = error.message;
    return;
  } finally {
    busy = confirmDelete.disabled = cancelDelete.disabled = false;
    updateControls();
  }

  const key = snippetKey(project.name, file);
  if (favorites.has(key)) updateFavorite(key, false);
  if (selected === file) editor.setModel(null);
  models.get(key)?.dispose();
  models.delete(key);
  project.snippets = project.snippets.filter((name) => name !== file);
  showSnippetOptions(project, selected);
  deleteDialog.close();
  renderManager(project);
  newButton.focus();
  if (selected === file) await loadSnippet();
}

function promptSnippetName(file) {
  if (busy) return;
  fileToRename = file;
  nameDialogTitle.textContent = file ? 'Rename snippet' : 'New snippet';
  createButton.textContent = file ? 'Rename snippet' : 'Create snippet';
  newError.textContent = '';
  nameInput.value = file ? snippetName(file) : '';
  newDialog.showModal();
  if (file) nameInput.select();
}

function applySnippetRename(project, previousFile, snippet) {
  const { file } = snippet;
  if (file === previousFile) return;

  const oldKey = snippetKey(project.name, previousFile);
  const newKey = snippetKey(project.name, file);
  const previousModel = models.get(oldKey);
  const selected = snippetSelect.value;
  const active = selected === previousFile && editor.getModel() === previousModel;
  if (previousModel) {
    const view = active ? editor.saveViewState() : null;
    const unsaved = previousModel.getAlternativeVersionId() !== savedVersions.get(previousModel);
    const draft = unsaved ? previousModel.getValue() : null;
    if (active) editor.setModel(null);
    previousModel.dispose();
    models.delete(oldKey);

    const model = cacheSnippet(newKey, snippet);
    if (draft !== null && draft !== model.getValue()) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: draft }], () => null);
      model.pushStackElement();
    }
    if (active) {
      editor.setModel(model);
      if (view) editor.restoreViewState(view);
    }
  }

  if (favorites.delete(oldKey)) {
    favorites.add(newKey);
    persistFavorites();
  }
  project.snippets = project.snippets.map((name) => name === previousFile ? file : name).sort();
  showSnippetOptions(project, selected === previousFile ? file : selected);
}

async function submitSnippetName(event) {
  event.preventDefault();
  if (busy) return;

  const project = selectedProject();
  const original = fileToRename;
  const name = nameInput.value;
  busy = nameInput.disabled = cancelButton.disabled = createButton.disabled = true;
  newError.textContent = '';
  updateControls();
  try {
    const snippet = await request('snippet', {
      method: original ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(original ? { project: project.name, file: original, name } : { project: project.name, file: name }),
    });
    if (original) {
      applySnippetRename(project, original, snippet);
      newDialog.close();
      renderManager(project, snippet.file, 'rename');
      return;
    }
    project.snippets.push(snippet.file);
    project.snippets.sort();
    showSnippetOptions(project, snippet.file);
    const key = snippetKey(project.name, snippet.file);
    editor.setModel(cacheSnippet(key, snippet));
    clearOutput();
    newDialog.close();
    manager.close();
    editor.setPosition({ lineNumber: 2, column: 1 });
    editor.focus();
  } catch (error) {
    newError.textContent = error.message;
  } finally {
    busy = nameInput.disabled = cancelButton.disabled = createButton.disabled = false;
    updateControls();
    if (newDialog.open) nameInput.focus();
  }
}

async function saveCurrentSnippet() {
  if (saveButton.disabled || newDialog.open) return;

  const model = editor.getModel();
  const version = model.getAlternativeVersionId();
  busy = true;
  updateControls();
  try {
    await request('snippet', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectSelect.value, file: snippetSelect.value, code: model.getValue() }),
    });
    savedVersions.set(model, version);
    setStatus('Saved', 'success');
  } catch (error) {
    showOutput(error.message, 'Save failed', 'error');
  } finally {
    busy = false;
    updateControls();
  }
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
manageButton.addEventListener('click', () => {
  managerStatus.textContent = '';
  renderManager(selectedProject());
  manager.showModal();
});
document.querySelector('#close-manager').addEventListener('click', () => manager.close());
newButton.addEventListener('click', () => promptSnippetName());
newForm.addEventListener('submit', submitSnippetName);
cancelButton.addEventListener('click', () => newDialog.close());
newDialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
deleteForm.addEventListener('submit', deleteCurrentSnippet);
cancelDelete.addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
saveButton.addEventListener('click', saveCurrentSnippet);
runButton.addEventListener('click', runCurrentSnippet);
clearButton.addEventListener('click', clearOutput);
editor.onDidChangeModelContent(updateControls);
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
