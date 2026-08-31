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

  it('shows tool, operation and request payload on the request tab', async () => {
    const logs: DashboardEvent[] = [
      { type: 'request', ts: 0, id: 'r1', tool: 'mcp', operation: 'classify', inputHint: '{"task":"fix"}' },
    ];
    const wrapper = mount(LogsPanel, { props: { logs, traces: [] } });
    const requestTab = wrapper.findAll('button').find((b) => b.text() === 'request');
    expect(requestTab).toBeTruthy();
    await requestTab!.trigger('click');
    expect(wrapper.text()).toContain('mcp');
    expect(wrapper.text()).toContain('classify');
    expect(wrapper.text()).toContain('{"task":"fix"}');
  });

  it('shows ok, latency and full response content on the response tab', async () => {
    const logs: DashboardEvent[] = [
      { type: 'response', ts: 0, id: 'r1', ok: true, latencyMs: 42, outputHint: '{"task":"coding_fix"}' },
    ];
    const wrapper = mount(LogsPanel, { props: { logs, traces: [] } });
    const responseTab = wrapper.findAll('button').find((b) => b.text() === 'response');
    expect(responseTab).toBeTruthy();
    await responseTab!.trigger('click');
    expect(wrapper.text()).toContain('ok');
    expect(wrapper.text()).toContain('42ms');
    expect(wrapper.text()).toContain('{"task":"coding_fix"}');
  });
});
