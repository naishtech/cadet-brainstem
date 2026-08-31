import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LogsPanel from '../LogsPanel.vue';
import type { DashboardEvent } from '../../types';
import type { Trace } from '../../store';

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    logs: [] as DashboardEvent[],
    traces: [] as Trace[],
    steeringLogs: [] as DashboardEvent[],
    procedureLogs: [] as DashboardEvent[],
    steeringTraces: [] as Trace[],
    procedureTraces: [] as Trace[],
    ...overrides,
  };
}

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
    const wrapper = mount(LogsPanel, { props: baseProps({ logs }) });
    expect(wrapper.text()).toContain('llm:up');
    expect(wrapper.text()).toContain('rtk:down');
  });

  it('shows a message for a log event', () => {
    const logs: DashboardEvent[] = [
      { type: 'log', level: 'info', ts: 0, source: 'mcp', message: 'hello world' },
    ];
    const wrapper = mount(LogsPanel, { props: baseProps({ logs }) });
    expect(wrapper.text()).toContain('hello world');
  });

  it('shows tool, operation and request payload on the steering tab', async () => {
    const logs: DashboardEvent[] = [
      { type: 'request', ts: 0, id: 'r1', tool: 'mcp', operation: 'steering', inputHint: '{"task":"fix"}' },
    ];
    const wrapper = mount(LogsPanel, {
      props: baseProps({ logs, steeringLogs: logs }),
    });
    const steeringTab = wrapper.findAll('button').find((b) => b.text() === 'steering');
    expect(steeringTab).toBeTruthy();
    await steeringTab!.trigger('click');
    expect(wrapper.text()).toContain('mcp');
    expect(wrapper.text()).toContain('steering');
    expect(wrapper.text()).toContain('{"task":"fix"}');
  });

  it('keeps steering requests out of the procedures stream', async () => {
    const logs: DashboardEvent[] = [
      { type: 'request', ts: 0, id: 'r1', tool: 'mcp', operation: 'steering', inputHint: '{"task":"fix"}' },
    ];
    const wrapper = mount(LogsPanel, {
      props: baseProps({ logs, steeringLogs: logs, procedureLogs: [] }),
    });
    const proceduresTab = wrapper.findAll('button').find((b) => b.text() === 'procedures');
    await proceduresTab!.trigger('click');
    expect(wrapper.text()).toContain('No procedures events yet.');
    expect(wrapper.text()).not.toContain('{"task":"fix"}');
  });

  it('shows ok, latency and full response content on the procedures tab', async () => {
    const logs: DashboardEvent[] = [
      { type: 'response', ts: 0, id: 'r1', ok: true, latencyMs: 42, outputHint: '{"task":"coding_fix"}' },
    ];
    const wrapper = mount(LogsPanel, {
      props: baseProps({ logs, procedureLogs: logs }),
    });
    const proceduresTab = wrapper.findAll('button').find((b) => b.text() === 'procedures');
    expect(proceduresTab).toBeTruthy();
    await proceduresTab!.trigger('click');
    expect(wrapper.text()).toContain('ok');
    expect(wrapper.text()).toContain('42ms');
    expect(wrapper.text()).toContain('{"task":"coding_fix"}');
  });

  it('renders the thinking trace under the procedures stream', async () => {
    const traces: Trace[] = [
      { id: 't1', model: 'procedure', request: '', tokens: '', thinking: 'step reasoning', complete: false, category: 'procedures' },
    ];
    const wrapper = mount(LogsPanel, {
      props: baseProps({ traces, procedureTraces: traces }),
    });
    const proceduresTab = wrapper.findAll('button').find((b) => b.text() === 'procedures');
    await proceduresTab!.trigger('click');
    expect(wrapper.text()).toContain('Thinking');
    expect(wrapper.text()).toContain('step reasoning');
  });
});
