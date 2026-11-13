import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { tokenColor } from "./theme";
import { TermInfo, termClose, termInfo, termOpen, termRead, termResize, termWrite } from "./api";

const INFO_POLL_MS = 1_500;

/**
 * One terminal pane running the user's default shell, with a header naming the
 * foreground program and folder. The shell ends when the pane unmounts; when
 * the shell exits on its own, the pane closes.
 */
export function TerminalView(props: {
  cwd: string;
  /** A command typed into the shell once, when it opens. */
  run?: string;
  focused: boolean;
  onFocus: () => void;
  /** The shell's current folder, so the space can follow it. */
  onCwd: (cwd: string) => void;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [id, setId] = useState<number | null>(null);
  const [info, setInfo] = useState<TermInfo | null>(null);
  // The read loop and poll outlive renders; always call the latest handlers.
  const ranRef = useRef(false);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const onCwdRef = useRef(props.onCwd);
  onCwdRef.current = props.onCwd;

  useEffect(() => {
    const host = hostRef.current!;
    const theme = () => ({
      background: tokenColor("--color-paper-3"),
      foreground: tokenColor("--color-ink"),
      cursor: tokenColor("--color-accent"),
      selectionBackground: tokenColor("--color-accent-soft"),
    });
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: theme(),
    });
    const onTheme = () => (term.options.theme = theme());
    window.addEventListener("panguyuban:theme", onTheme);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (host.clientWidth > 0) fit.fit();
    termRef.current = term;

    let opened: number | null = null;
    let disposed = false;

    (async () => {
      try {
        opened = await termOpen(term.cols, term.rows, props.cwd);
      } catch (err) {
        term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
        return;
      }
      if (disposed) return void termClose(opened);
      setId(opened);
      if (props.run && !ranRef.current) {
        ranRef.current = true;
        termWrite(opened, props.run + "\r");
      }
      for (;;) {
        const chunk = await termRead(opened).catch(() => new ArrayBuffer(0));
        if (disposed) return;
        if (chunk.byteLength === 0) break;
        term.write(new Uint8Array(chunk));
      }
      termClose(opened);
      onCloseRef.current();
    })();

    const input = term.onData((data) => {
      if (opened !== null) termWrite(opened, data);
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (opened !== null) termResize(opened, cols, rows);
    });
    // Hidden panes measure 0 wide; fitting then would shrink the shell to nothing.
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0) fit.fit();
    });
    observer.observe(host);

    return () => {
      disposed = true;
      window.removeEventListener("panguyuban:theme", onTheme);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      if (opened !== null) termClose(opened);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (props.focused) termRef.current?.focus();
  }, [props.focused]);

  // Header text and the space's name follow the shell, so poll even while hidden.
  useEffect(() => {
    if (id === null) return;
    const poll = () =>
      termInfo(id).then((next) => {
        setInfo(next);
        onCwdRef.current(next.cwd);
      }, () => {});
    poll();
    const timer = setInterval(poll, INFO_POLL_MS);
    return () => clearInterval(timer);
  }, [id]);

  return (
    <div className="term-pane" data-focused={props.focused || undefined} onMouseDown={props.onFocus}>
      <div className="term-pane-head">
        <span className="term-pane-glyph" aria-hidden="true">
          ›_
        </span>
        <span className="term-pane-cmd">{info?.command || "shell"}</span>
        <span className="term-pane-cwd">{info?.cwd || props.cwd}</span>
        <span className="term-pane-tools">
          <button type="button" className="refresh-btn" title="Split right (⌘D)" aria-label="Split right" onClick={() => props.onSplit("row")}>
            ◧
          </button>
          <button type="button" className="refresh-btn" title="Split down (⇧⌘D)" aria-label="Split down" onClick={() => props.onSplit("col")}>
            ⬒
          </button>
          <button type="button" className="refresh-btn" title="Close pane" aria-label="Close pane" onClick={props.onClose}>
            ×
          </button>
        </span>
      </div>
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
}
