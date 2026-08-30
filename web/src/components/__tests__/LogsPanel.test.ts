import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LogsPanel from '../LogsPanel.vue';
import type { DashboardEvent } from '../../types';

describe('LogsPanel', () => {
  it('renders a status event with per-service state', () => {
    const logs: DashboardEvent[] = [
      {
        type: 'status',
        ts: 0,
        services: [
          { name: 'ollama', kind: 'llm', available: true, detail: 'qwen3:4b' },
          { name: 'rtk', kind: 'rtk', available: false },
        ],
      },
    ];
    const wrapper = mount(LogsPanel, { props: { logs, traces: [] } });
    expect(wrapper.text()).toContain('llm:up');
    expect(wrapper.text()).toContain('rtk:down');
  });

  it('shows a message for a log event', () => {
    const logs: DashboardEvent[] = [
      { type: 'log', level: 'info', ts: 0, source: 'mcp', message: 'hello world' },
    ];
    const wrapper = mount(LogsPanel, { props: { logs, traces: [] } });
    expect(wrapper.text()).toContain('hello world');
  });
});
