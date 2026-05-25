import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TerminalHandle {
  write: (data: string) => void;
  writeln: (data: string) => void;
  clear: () => void;
  fit: () => void;
  getAllText: () => string;
  getSelection: () => string;
}

interface Props {
  hideToolbar?: boolean;
  downloadName?: string;
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const TerminalView = forwardRef<TerminalHandle, Props>(({ hideToolbar, downloadName }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      // Stick to system monospace fonts so widths are stable and don't shift after webfont load
      fontFamily: 'Consolas, "Liberation Mono", Menlo, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0b1220',
        foreground: '#e2e8f0',
        cursor: '#34d399',
        selectionBackground: '#3b82f680',
        selectionForeground: '#f8fafc',
        black: '#1e293b',
        brightBlack: '#64748b',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightWhite: '#f8fafc',
      },
      convertEol: true,
      scrollback: 10000,
      disableStdin: true,
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        e.preventDefault();
        writeClipboard(term.getSelection()).then((ok) => ok && flash('已复制'));
        return false;
      }
      if (key === 'a' && !e.shiftKey) {
        e.preventDefault();
        term.selectAll();
        return false;
      }
      if (key === 'l') {
        e.preventDefault();
        term.clear();
        return false;
      }
      return true;
    });

    // Multiple fit attempts to handle: initial layout, late web-fonts, parent visibility toggles
    const safeFit = () => {
      try {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;  // skip when hidden / sized to nothing
        fit.fit();
      } catch { /* swallow */ }
    };

    requestAnimationFrame(safeFit);
    const t1 = setTimeout(safeFit, 100);
    const t2 = setTimeout(safeFit, 400);
    if (document.fonts?.ready) {
      document.fonts.ready.then(safeFit).catch(() => {});
    }

    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(containerRef.current);

    // Re-fit whenever the page becomes visible again (handles tab switching nicely)
    const onVis = () => { if (!document.hidden) safeFit(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [flash]);

  const copySelection = useCallback(async () => {
    const sel = termRef.current?.getSelection() ?? '';
    if (!sel) { flash('请先选中文本'); return; }
    const ok = await writeClipboard(sel);
    flash(ok ? '已复制选中' : '复制失败');
  }, [flash]);

  const collectAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return '';
    const lines: string[] = [];
    for (let i = 0; i < term.buffer.active.length; i++) {
      const line = term.buffer.active.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }, []);

  const copyAll = useCallback(async () => {
    const text = collectAll();
    if (!text.trim()) { flash('没有可复制的内容'); return; }
    const ok = await writeClipboard(text);
    flash(ok ? '已复制全部输出' : '复制失败');
  }, [collectAll, flash]);

  const download = useCallback(() => {
    const text = collectAll();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName || `opslab-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [collectAll, downloadName]);

  const clear = useCallback(() => termRef.current?.clear(), []);

  useImperativeHandle(ref, () => ({
    write: (data) => termRef.current?.write(data),
    writeln: (data) => termRef.current?.writeln(data),
    clear: () => termRef.current?.clear(),
    fit: () => fitRef.current?.fit(),
    getAllText: collectAll,
    getSelection: () => termRef.current?.getSelection() ?? '',
  }));

  // Toolbar is absolutely positioned so it doesn't interfere with xterm layout/measurements.
  // xterm gets the FULL container — no flex sibling, no padding — which keeps mouse↔row math correct.
  return (
    <div className="h-full w-full bg-[#0b1220] rounded overflow-hidden relative">
      <div ref={containerRef} className="absolute inset-0" />
      {!hideToolbar && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 bg-ink-900/85 border border-ink-700/40 rounded backdrop-blur-sm text-xs text-ink-400 z-10 select-none shadow-lg">
          <button
            onClick={copySelection}
            className="px-2 py-1 hover:bg-ink-800 hover:text-ink-100 rounded transition-colors"
            title="复制选中 (Ctrl/Cmd+C)"
          >📋</button>
          <button
            onClick={copyAll}
            className="px-2 py-1 hover:bg-ink-800 hover:text-ink-100 rounded transition-colors"
            title="复制全部输出"
          >📑</button>
          <button
            onClick={download}
            className="px-2 py-1 hover:bg-ink-800 hover:text-ink-100 rounded transition-colors"
            title="下载为 .log 文件"
          >💾</button>
          <button
            onClick={clear}
            className="px-2 py-1 hover:bg-ink-800 hover:text-ink-100 rounded transition-colors"
            title="清屏 (Ctrl/Cmd+L)"
          >🗑</button>
        </div>
      )}
      {toast && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded shadow-lg pointer-events-none z-20">
          {toast}
        </div>
      )}
    </div>
  );
});

TerminalView.displayName = 'TerminalView';
