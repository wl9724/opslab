import { db, commandsRepo } from './db.js';
import type { TargetType, TemplateVar } from './types.js';

interface Seed {
  name: string;
  description: string;
  template: string;
  targetType: TargetType;
  vars: TemplateVar[];
  tags: string[];
  interpreter?: string;
}

const SEEDS: Seed[] = [
  {
    name: '系统信息',
    description: '查看操作系统、内核、硬件概况',
    template: 'uname -a && cat /etc/os-release 2>/dev/null || systeminfo',
    targetType: 'local',
    vars: [],
    tags: ['system', 'starter'],
  },
  {
    name: '磁盘占用 Top 20',
    description: '当前目录下占用最大的 20 个文件/目录',
    template: 'du -ah {{path}} 2>/dev/null | sort -hr | head -n 20',
    targetType: 'local',
    vars: [
      { name: 'path', label: '路径', type: 'text', defaultValue: '.', required: true },
    ],
    tags: ['disk', 'starter'],
  },
  {
    name: '端口占用 (Linux/Mac)',
    description: '查看某端口被哪个进程占用',
    template: 'lsof -nP -iTCP:{{port}} -sTCP:LISTEN || ss -ltnp | grep :{{port}}',
    targetType: 'local',
    vars: [
      { name: 'port', label: '端口', type: 'number', defaultValue: '80', required: true },
    ],
    tags: ['network'],
  },
  {
    name: '端口占用 (Windows)',
    description: 'PowerShell 查看端口占用',
    template: 'Get-NetTCPConnection -LocalPort {{port}} | Select-Object LocalAddress,LocalPort,State,OwningProcess | Format-Table',
    targetType: 'local',
    vars: [
      { name: 'port', label: '端口', type: 'number', defaultValue: '80', required: true },
    ],
    tags: ['network', 'windows'],
  },
  {
    name: 'docker ps',
    description: '查看运行中的容器',
    template: 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"',
    targetType: 'docker',
    vars: [],
    tags: ['docker'],
  },
  {
    name: 'docker 容器日志',
    description: '跟踪容器最近 200 行日志',
    template: 'docker logs --tail 200 -f {{container}}',
    targetType: 'docker',
    vars: [
      { name: 'container', label: '容器名/ID', type: 'text', required: true },
    ],
    tags: ['docker', 'logs'],
  },
  {
    name: 'docker 进入容器',
    description: '在容器内打开 shell（一次性命令）',
    template: 'docker exec {{container}} {{cmd}}',
    targetType: 'docker',
    vars: [
      { name: 'container', label: '容器名/ID', type: 'text', required: true },
      { name: 'cmd', label: '命令', type: 'text', defaultValue: 'sh -c "ls /"', required: true },
    ],
    tags: ['docker'],
  },
  {
    name: 'kubectl 列 Pod',
    description: '列出指定 namespace 的 Pod',
    template: 'kubectl get pods -n {{namespace}} -o wide',
    targetType: 'k8s',
    vars: [
      { name: 'namespace', label: 'Namespace', type: 'text', defaultValue: 'default', required: true },
    ],
    tags: ['k8s'],
  },
  {
    name: 'kubectl 看日志',
    description: '看 Pod 日志（可指定容器）',
    template: 'kubectl logs -n {{namespace}} {{pod}} {{container_flag}} --tail={{tail}} -f',
    targetType: 'k8s',
    vars: [
      { name: 'namespace', label: 'Namespace', type: 'text', defaultValue: 'default', required: true },
      { name: 'pod', label: 'Pod 名', type: 'text', required: true },
      { name: 'container_flag', label: '容器 (-c name 或留空)', type: 'text', defaultValue: '', required: false },
      { name: 'tail', label: '行数', type: 'number', defaultValue: '200', required: true },
    ],
    tags: ['k8s', 'logs'],
  },
  {
    name: 'kubectl describe',
    description: '查看 Pod 详细信息和事件',
    template: 'kubectl describe pod {{pod}} -n {{namespace}}',
    targetType: 'k8s',
    vars: [
      { name: 'namespace', label: 'Namespace', type: 'text', defaultValue: 'default', required: true },
      { name: 'pod', label: 'Pod 名', type: 'text', required: true },
    ],
    tags: ['k8s'],
  },
  {
    name: 'git 当前状态',
    description: '快速看仓库状态',
    template: 'cd {{repo}} && git status --short && echo "---" && git log --oneline -5',
    targetType: 'local',
    vars: [
      { name: 'repo', label: '仓库路径', type: 'text', defaultValue: '.', required: true },
    ],
    tags: ['git'],
  },
  {
    name: '示例：Python 脚本',
    description: '演示用 Python 解释器执行多行脚本',
    interpreter: 'python3',
    template: `import os, sys, platform

print(f"Python {sys.version.split()[0]} on {platform.system()}")
print(f"CWD: {os.getcwd()}")

target = "{{path}}"
total = 0
count = 0
for root, dirs, files in os.walk(target):
    for f in files:
        try:
            total += os.path.getsize(os.path.join(root, f))
            count += 1
        except OSError:
            pass

print(f"\\n{target}: {count} files, {total / 1024 / 1024:.1f} MB")
`,
    targetType: 'local',
    vars: [
      { name: 'path', label: '目录', type: 'text', defaultValue: '.', required: true },
    ],
    tags: ['python', 'script', 'example'],
  },
  {
    name: '示例：Bash 脚本',
    description: '演示多行 Bash 脚本（带循环和判断）',
    interpreter: 'bash',
    template: `#!/usr/bin/env bash
set -euo pipefail

threshold={{threshold_mb}}
echo "查找占用超过 \${threshold}MB 的进程："
echo

ps -eo pid,user,rss,comm --sort=-rss | awk -v t="$threshold" '
  NR==1 {print; next}
  $3/1024 > t {printf "%-6s %-12s %6.1fMB  %s\\n", $1, $2, $3/1024, $4}
'
`,
    targetType: 'local',
    vars: [
      { name: 'threshold_mb', label: '阈值 (MB)', type: 'number', defaultValue: '500', required: true },
    ],
    tags: ['bash', 'script', 'example'],
  },
];

export function seedIfEmpty(): void {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM commands').get() as { count: number };
  if (count > 0) return;
  for (const s of SEEDS) {
    commandsRepo.create({
      ...s,
      interpreter: s.interpreter ?? 'auto',
      favorite: false,
    });
  }
  console.log(`[opslab] seeded ${SEEDS.length} starter commands`);
}
