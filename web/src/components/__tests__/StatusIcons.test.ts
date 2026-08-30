import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusIcons from '../StatusIcons.vue';
import type { ToolStatus } from '../../types';

const services: ToolStatus[] = [
  { name: 'ollama', kind: 'llm', available: true, detail: 'qwen3:4b' },
  { name: 'rtk', kind: 'rtk', available: true, detail: '0.45.0' },
  { name: 'serena', kind: 'serena', available: true, detail: '1.0.0' },
  { name: 'leanctx', kind: 'leanctx', available: true, detail: '2.1.0' },
];

describe('StatusIcons', () => {
  it('renders one icon per service with the correct availability', () => {
    const wrapper = mount(StatusIcons, { props: { services } });
    const icons = wrapper.findAll('[data-kind]');
    expect(icons).toHaveLength(4);
    expect(icons[0]!.attributes('data-available')).toBe('true');
  });

  it('shows the service kind in all caps', () => {
    const wrapper = mount(StatusIcons, { props: { services } });
    expect(wrapper.text()).toContain('LLM');
    expect(wrapper.text()).toContain('RTK');
    expect(wrapper.text()).toContain('SERENA');
    expect(wrapper.text()).toContain('LEANCTX');
  });

  it('shows the running model / versions in brackets', () => {
    const wrapper = mount(StatusIcons, { props: { services } });
    expect(wrapper.text()).toContain('[qwen3:4b]');
    expect(wrapper.text()).toContain('[0.45.0]');
    expect(wrapper.text()).toContain('[1.0.0]');
    expect(wrapper.text()).toContain('[2.1.0]');
  });
});
