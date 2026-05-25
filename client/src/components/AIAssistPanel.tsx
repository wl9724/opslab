import { useEffect, useRef, useState } from 'react';
import { api, extractCodeBlocks } from '../lib/api';
import { useStore } from '../lib/store';
import type { TargetType } from '../lib/types';

interface Msg { role: 'user' | 'assistant'; content: string }

interface Props {
  context?: {
    targetType?: TargetType;
    connectionName?: string;
    currentCommand?: string;
  };
  onInsert?: (code: string) => void;
}

export function AIAssistPanel({ context, onInsert }: Props) {
  const providers = useStore((s) => s.providers);
  const os = useStore((s) => s.os);
  const shell = useStore((s) => s.shell);
  const defaultProvider = providers.find((p) => p.isDefault && p.enabled) ?? providers.find((p) => p.enabled);

  const [providerId, setProviderId] = useState<string | undefined>(defaultProvider?.id);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerId && defaultProvider) setProviderId(defaultProvider.id);
  }, [defaultProvider, providerId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const enabledProviders = providers.filter((p) => p.enabled);

  async function send() {
    if (!input.trim() || streaming) return;
    if (!providerId) return;
    const userMsg: Msg = { role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setStreaming(true);
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);

    let acc = '';
    try {
      for await (const ev of api.chat({
        providerId,
        messages: nextMessages,
        context: {
          os,
          shell,
          targetType: context?.targetType,
          connectionName: context?.connectionName,
          currentCommand: context?.currentCommand,
        },
      })) {
        if (ev.type === 'text') {
          acc += ev.delta;
          setMessages((cur) => {
            const copy = cur.slice();
            copy[copy.length - 1] = { role: 'assistant', content: acc };
            return copy;
          });
        } else if (ev.type === 'error') {
          acc += `\n\n[error] ${ev.message}`;
          setMessages((cur) => {
            const copy = cur.slice();
            copy[copy.length - 1] = { role: 'assistant', content: acc };
            return copy;
          });
        }
      }
    } finally {
      setStreaming(false);
    }
  }

  if (enabledProviders.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-400 border border-ink-800 rounded">
        尚未配置 AI Provider。请先到 <span className="text-emerald-400">AI 设置</span> 添加一个。
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border border-ink-800 rounded overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-800 bg-ink-900 flex items-center gap-2">
        <span className="text-sm text-ink-300">AI 助手</span>
        <select
          value={providerId ?? ''}
          onChange={(e) => setProviderId(e.target.value)}
          className="ml-auto bg-ink-800 border border-ink-700 rounded px-2 py-0.5 text-xs"
        >
          {enabledProviders.map((p) => (
            <option key={p.id} value={p.id}>{p.name} · {p.model}</option>
          ))}
        </select>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="text-xs text-ink-400 hover:text-ink-200"
          >清空</button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-xs text-ink-500 leading-relaxed">
            描述你想做的事，AI 会生成命令。例如：<br />
            • "列出当前目录所有大于 100MB 的文件"<br />
            • "重启 nginx 服务"<br />
            • "查看名字包含 redis 的 pod 的日志"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'pl-4 border-l-2 border-emerald-500' : 'pl-4 border-l-2 border-ink-700'}>
            <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-1">
              {m.role === 'user' ? '你' : 'AI'}
            </div>
            <div className="text-sm text-ink-200 whitespace-pre-wrap break-words">{m.content || '…'}</div>
            {m.role === 'assistant' && onInsert && extractCodeBlocks(m.content).map((blk, j) => (
              <div key={j} className="mt-2 bg-ink-950 border border-ink-800 rounded">
                <div className="px-2 py-1 text-xs text-ink-400 flex items-center justify-between border-b border-ink-800">
                  <span>{blk.lang}</span>
                  <button
                    onClick={() => onInsert(blk.code)}
                    className="text-emerald-400 hover:text-emerald-300"
                  >塞入编辑器 →</button>
                </div>
                <pre className="p-2 text-xs font-mono text-emerald-200 overflow-x-auto whitespace-pre-wrap">{blk.code}</pre>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-ink-800 p-2 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="告诉 AI 你想做什么…（Ctrl/Cmd+Enter 发送）"
          rows={2}
          className="flex-1 bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm resize-none focus:outline-none focus:border-emerald-500"
        />
        <button
          onClick={send}
          disabled={streaming || !input.trim()}
          className="px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded text-sm font-medium"
        >{streaming ? '…' : '发送'}</button>
      </div>
    </div>
  );
}
