import React, { useEffect, useState } from "react";
import { DirEntry, folderChanges, folderList, folderReadFile } from "./api";
import { DiffFiles, Icon } from "./ui";

export type PanelMode = "files" | "changes";

const CHANGES_POLL_MS = 5_000;

/** Side panel beside the terminals: the focused terminal's folder as a file tree, or its uncommitted diff. */
export function FolderPanel(props: { mode: PanelMode; cwd: string; onClose: () => void }) {
  // Bumped by ↻: remounts the tree, refetches the diff.
  const [nonce, setNonce] = useState(0);
  const title = props.mode === "files" ? "Files" : "Changes";
  return (
    <aside className="folder-panel" aria-label={title}>
      <div className="folder-panel-head">
        <span className="term-pane-cmd">{title}</span>
        <span className="term-pane-cwd" title={props.cwd}>
          {props.cwd}
        </span>
        <button
          type="button"
          className="refresh-btn"
          aria-label={`Refresh ${title}`}
          title="Refresh"
          onClick={() => setNonce((n) => n + 1)}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" className="refresh-btn" aria-label={`Close ${title}`} title="Close" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="folder-panel-body">
        {props.mode === "files" ? (
          <FilesView key={`${props.cwd}#${nonce}`} cwd={props.cwd} />
        ) : (
          <ChangesView cwd={props.cwd} nonce={nonce} />
        )}
      </div>
    </aside>
  );
}

function FilesView({ cwd }: { cwd: string }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Tree stays mounted under the preview so going back keeps what was expanded.
  return (
    <>
      {openFile && <FilePreview path={openFile} root={cwd} onBack={() => setOpenFile(null)} />}
      <div className="file-tree" role="tree" hidden={openFile !== null}>
        <DirChildren path={cwd} depth={0} onOpen={setOpenFile} />
      </div>
    </>
  );
}

/** One folder's entries, fetched when it is first shown. */
function DirChildren(props: { path: string; depth: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    folderList(props.path).then(setEntries, (err) => setError(String(err)));
  }, [props.path]);

  const indent = { paddingLeft: 8 + props.depth * 14 };
  if (error) return <div className="tree-note" style={indent}>{error}</div>;
  if (!entries) return <div className="tree-note" style={indent}>Loading…</div>;
  if (entries.length === 0) return <div className="tree-note" style={indent}>Empty folder</div>;
  return (
    <>
      {entries.map((entry) => (
        <TreeRow key={entry.name} entry={entry} path={`${props.path}/${entry.name}`} depth={props.depth} onOpen={props.onOpen} />
      ))}
    </>
  );
}

function TreeRow(props: { entry: DirEntry; path: string; depth: number; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const { entry } = props;
  return (
    <>
      <button
        type="button"
        role="treeitem"
        className="tree-row"
        data-dir={entry.is_dir || undefined}
        style={{ paddingLeft: 8 + props.depth * 14 }}
        aria-expanded={entry.is_dir ? open : undefined}
        title={props.path}
        onClick={() => (entry.is_dir ? setOpen(!open) : props.onOpen(props.path))}
      >
        <span className="tree-glyph" aria-hidden="true">
          {entry.is_dir ? (open ? "▾" : "▸") : ""}
        </span>
        {entry.name}
      </button>
      {open && <DirChildren path={props.path} depth={props.depth + 1} onOpen={props.onOpen} />}
    </>
  );
}

function FilePreview(props: { path: string; root: string; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    folderReadFile(props.path).then(setText, (err) => setError(String(err)));
  }, [props.path]);

  return (
    <div className="file-preview">
      <button type="button" className="tree-row file-preview-back" onClick={props.onBack}>
        <span className="tree-glyph" aria-hidden="true">
          ←
        </span>
        {props.path.slice(props.root.length + 1)}
      </button>
      {error ? (
        <div className="tree-note">{error}</div>
      ) : text === null ? (
        <div className="tree-note">Loading…</div>
      ) : (
        <pre className="file-preview-text">{text}</pre>
      )}
    </div>
  );
}

/** The folder's uncommitted diff, re-read every few seconds so agent edits show up. */
function ChangesView({ cwd, nonce }: { cwd: string; nonce: number }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLines(null);
    setError(null);
    const load = () =>
      folderChanges(cwd).then(
        (next) => {
          setLines(next);
          setError(null);
        },
        (err) => setError(String(err))
      );
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, CHANGES_POLL_MS);
    return () => clearInterval(timer);
  }, [cwd, nonce]);

  if (error) return <div className="tree-note">{error}</div>;
  if (!lines) return <div className="tree-note">Loading…</div>;
  if (lines.length === 0) return <div className="tree-note">No changes</div>;
  return <DiffFiles lines={lines} />;
}
