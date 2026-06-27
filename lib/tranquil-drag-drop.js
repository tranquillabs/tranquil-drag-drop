const { CompositeDisposable, Disposable } = require('atom');
const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const UNDO_LIMIT = 50;

// Returns the multi-part extension of a path, e.g. ".tar.gz" for
// "archive.tar.gz". Mirrors tree-view's getFullExtension so our auto-numbered
// copies match its conflict-naming behaviour.
function getFullExtension(filePath) {
  const base = path.basename(filePath);
  const idx = base.indexOf('.', base.startsWith('.') ? 1 : 0);
  return idx === -1 ? '' : base.slice(idx);
}

// Strips characters that are illegal in filenames and trims to a sane length.
function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .trim()
    .slice(0, 64);
}

// Given a desired destination path, returns one that does not collide with an
// existing file by appending an incrementing counter before the extension.
function uniquePath(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = getFullExtension(destPath);
  const base = path.basename(destPath, ext);
  let counter = 0;
  let candidate;
  do {
    candidate = path.join(dir, `${base}${counter}${ext}`);
    counter += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function isUrl(uri) {
  return /^(https?|tranquil-browser):\/\//i.test(uri);
}

function deriveUrlTitle(uri) {
  try {
    return new URL(uri).hostname || 'link';
  } catch {
    return 'link';
  }
}

module.exports = {
  subscriptions: null,
  // Stack of reversible operations: { type: 'create', path } | { type: 'move', from, to }.
  undoStack: null,
  // The directory entry currently highlighted as a drop target.
  dropTarget: null,

  activate() {
    this.subscriptions = new CompositeDisposable();
    this.undoStack = [];

    this.registerTabDropListeners();
    this.observeTreeViewOperations();

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-drag-drop:undo': () => this.undoLast(),
      })
    );
  },

  deactivate() {
    this.clearHighlight();
    if (this.subscriptions) this.subscriptions.dispose();
    this.subscriptions = null;
    this.undoStack = null;
  },

  // --- Tab → tree-view drop handling -------------------------------------

  registerTabDropListeners() {
    const onDragOver = (event) => this.onDragOver(event);
    const onDrop = (event) => this.onDrop(event);
    const onDragEnd = () => this.clearHighlight();

    // Listen in the capture phase: the tree-view sits inside a dock pane whose
    // pane-element handlers call stopPropagation() during the bubble phase,
    // which would otherwise swallow the drag before it reaches us. Capturing on
    // `document` lets us claim tab drags over the tree-view first.
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    // Clear any stale highlight once the drag finishes anywhere.
    document.addEventListener('dragend', onDragEnd, true);

    this.subscriptions.add(
      new Disposable(() => {
        document.removeEventListener('dragover', onDragOver, true);
        document.removeEventListener('drop', onDrop, true);
        document.removeEventListener('dragend', onDragEnd, true);
      })
    );
  },

  // The dock element (e.g. <atom-dock>) that hosts the tree-view, or null.
  treeViewDock() {
    const treeView = document.querySelector('.tree-view');
    return treeView ? treeView.closest('atom-dock') : null;
  },

  // True only for tab drags (file or browser) that are currently over the dock
  // hosting the tree-view. Everything else (core file/root drags, OS files,
  // drags over editor panes) is left untouched.
  //
  // We match the whole dock — not just the `.tree-view` element — so drops that
  // land on the pane's tab-bar or on the dock's drag overlay (both revealed by
  // Atom during a tab drag) are still claimed by us. Otherwise Atom would move
  // the dragged item into the dock instead of saving it.
  isTabDropOnTreeView(event) {
    if (!Array.from(event.dataTransfer.types).includes('atom-tab-event')) {
      return false;
    }
    const dock = this.treeViewDock();
    if (dock && dock.contains(event.target)) return true;
    return event.target.closest('.tree-view') != null;
  },

  onDragOver(event) {
    if (!this.isTabDropOnTreeView(event)) {
      // If a drag wanders out of the tree-view, drop the highlight.
      if (this.dropTarget) this.clearHighlight();
      return;
    }
    // Claim the drag from the dock pane's bubble-phase handlers.
    event.preventDefault();
    event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = 'copy';
    this.setHighlight(event.target.closest('.entry.directory'));
  },

  onDrop(event) {
    if (!this.isTabDropOnTreeView(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearHighlight();

    const targetDir = this.resolveTargetDirectory(event);
    if (!targetDir) {
      atom.notifications.addWarning('No folder to save into — open a project first.');
      return;
    }

    const uri = event.dataTransfer.getData('text/plain');
    if (isUrl(uri)) {
      this.saveUrlToTree(uri, targetDir);
    } else {
      this.saveFileToTree(event, uri, targetDir);
    }
  },

  // Resolves the directory to save into: the directory under the cursor, or
  // the first project root when dropping on empty tree-view space.
  resolveTargetDirectory(event) {
    const entry = event.target.closest('.entry.directory');
    const dirFromEntry = entry?.querySelector('.name')?.dataset.path;
    return dirFromEntry || atom.project.getPaths()[0] || null;
  },

  // Copies a file tab's backing file into the target folder. Untitled/unsaved
  // tabs are written from their in-memory contents.
  saveFileToTree(event, uri, targetDir) {
    let src = uri;
    if (src && src.startsWith('file://')) {
      src = decodeURI(src.replace(/^file:\/\//, ''));
    }

    if (src && fs.existsSync(src)) {
      try {
        const dest = uniquePath(path.join(targetDir, path.basename(src)));
        fs.cpSync(src, dest, { recursive: true });
        this.pushUndo({ type: 'create', path: dest });
        atom.notifications.addSuccess(`Saved ${path.basename(dest)} to ${path.basename(targetDir)}`);
      } catch (error) {
        atom.notifications.addError(`Could not save file: ${error.message}`);
      }
      return;
    }

    // Unsaved / untitled editor: write its current contents.
    const modified = event.dataTransfer.getData('modified-text');
    if (modified != null && modified !== '') {
      try {
        const dest = uniquePath(path.join(targetDir, 'untitled.txt'));
        fs.writeFileSync(dest, modified);
        this.pushUndo({ type: 'create', path: dest });
        atom.notifications.addSuccess(`Saved ${path.basename(dest)} to ${path.basename(targetDir)}`);
      } catch (error) {
        atom.notifications.addError(`Could not save file: ${error.message}`);
      }
      return;
    }

    atom.notifications.addWarning('Nothing to save from this tab.');
  },

  // Saves a browser tab as a .url shortcut, prompting for the location via the
  // shared save dialog (pre-filled to the drop-target folder).
  saveUrlToTree(url, targetDir) {
    const defaultPath = path.join(targetDir, `${sanitizeName(deriveUrlTitle(url))}.url`);
    ipcRenderer
      .invoke('show-save-url-dialog', { defaultPath })
      .then((result) => {
        if (result.canceled || !result.filePath) return;
        try {
          fs.writeFileSync(result.filePath, `[InternetShortcut]\nURL=${url}\n`);
          this.pushUndo({ type: 'create', path: result.filePath });
          atom.notifications.addSuccess(`Saved ${path.basename(result.filePath)}`);
        } catch (error) {
          atom.notifications.addError(`Could not save URL file: ${error.message}`);
        }
      })
      .catch((error) => {
        atom.notifications.addError(`Could not open save dialog: ${error.message}`);
      });
  },

  // --- Drop-target highlight ---------------------------------------------

  setHighlight(entry) {
    if (this.dropTarget === entry) return;
    this.clearHighlight();
    this.dropTarget = entry || null;
    if (this.dropTarget) this.dropTarget.classList.add('drag-over', 'selected');
  },

  clearHighlight() {
    if (this.dropTarget) {
      this.dropTarget.classList.remove('drag-over', 'selected');
      this.dropTarget = null;
    }
  },

  // --- Undo --------------------------------------------------------------

  // Subscribe to the live tree-view instance's file-operation emitters so that
  // ordinary within-tree moves and copies are also undoable. The tree-view may
  // activate after us, so wait for it if necessary.
  observeTreeViewOperations() {
    const hook = () => {
      const treeView = atom.packages
        .getActivePackage('tree-view')
        ?.mainModule?.getTreeViewInstance?.();
      if (!treeView) return false;
      // Move: reverse by moving newPath back to initialPath.
      this.subscriptions.add(
        treeView.onEntryMoved(({ initialPath, newPath }) =>
          this.pushUndo({ type: 'move', from: newPath, to: initialPath })
        )
      );
      // Copy: reverse by removing the created copy.
      this.subscriptions.add(
        treeView.onEntryCopied(({ newPath }) =>
          this.pushUndo({ type: 'create', path: newPath })
        )
      );
      return true;
    };

    if (!hook()) {
      const disposable = atom.packages.onDidActivatePackage((pkg) => {
        if (pkg.name === 'tree-view' && hook()) disposable.dispose();
      });
      this.subscriptions.add(disposable);
    }
  },

  pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  },

  undoLast() {
    const entry = this.undoStack.pop();
    if (!entry) {
      atom.notifications.addInfo('Nothing to undo.');
      return;
    }

    try {
      if (entry.type === 'create') {
        if (!fs.existsSync(entry.path)) {
          atom.notifications.addInfo('Already removed — nothing to undo.');
          return;
        }
        shell.trashItem(entry.path).then(
          () => atom.notifications.addInfo(`Undid: removed ${path.basename(entry.path)}`),
          (error) => atom.notifications.addError(`Could not undo: ${error.message}`)
        );
      } else if (entry.type === 'move') {
        if (!fs.existsSync(entry.from)) {
          atom.notifications.addInfo('Source moved — nothing to undo.');
          return;
        }
        if (fs.existsSync(entry.to)) {
          atom.notifications.addWarning('Cannot undo move: destination already exists.');
          return;
        }
        fs.renameSync(entry.from, entry.to);
        atom.notifications.addInfo(`Undid: moved ${path.basename(entry.to)} back`);
      }
    } catch (error) {
      atom.notifications.addError(`Could not undo: ${error.message}`);
    }
  },
};
