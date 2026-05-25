import { create } from 'zustand';
import type { CommandTemplate, Connection, AIProvider, Playbook } from './types';
import { api } from './api';

interface AppState {
  os: string;
  shell: string;
  commands: CommandTemplate[];
  connections: Connection[];
  providers: AIProvider[];
  playbooks: Playbook[];
  loading: boolean;
  error: string | null;
  loadAll: () => Promise<void>;
  reloadCommands: () => Promise<void>;
  reloadConnections: () => Promise<void>;
  reloadProviders: () => Promise<void>;
  reloadPlaybooks: () => Promise<void>;
}

export const useStore = create<AppState>((set) => ({
  os: '',
  shell: '',
  commands: [],
  connections: [],
  providers: [],
  playbooks: [],
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [me, commands, connections, providers, playbooks] = await Promise.all([
        api.me(),
        api.listCommands(),
        api.listConnections(),
        api.listProviders(),
        api.listPlaybooks(),
      ]);
      set({
        os: me.os,
        shell: me.shell,
        commands,
        connections,
        providers,
        playbooks,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  reloadCommands: async () => {
    const commands = await api.listCommands();
    set({ commands });
  },
  reloadConnections: async () => {
    const connections = await api.listConnections();
    set({ connections });
  },
  reloadProviders: async () => {
    const providers = await api.listProviders();
    set({ providers });
  },
  reloadPlaybooks: async () => {
    const playbooks = await api.listPlaybooks();
    set({ playbooks });
  },
}));
