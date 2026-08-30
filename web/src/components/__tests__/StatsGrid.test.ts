import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StatsGrid from '../StatsGrid.vue';
import type { StatsPayload } from '../../types';

const stats: StatsPayload = {
  count: 1,
  estimated: true,
  totals: {
    eventCount: 1,
    inputTokens: 1000,
    outputTokens: 100,
    tokensSaved: 900,
    reductionPct: 90,
    avgCompressionRatio: 0.1,
  },
  savingsByTool: [],
  savingsByTaskType: [],
  callStats: [],
  classifyByOrigin: [],
  recommendedByTool: [],
  sessions: [],
  mostExpensiveOperations: [],
};

describe('StatsGrid', () => {
  it('labels figures as ESTIMATES and renders totals', () => {
    const wrapper = mount(StatsGrid, { props: { stats } });
    expect(wrapper.text()).toContain('ESTIMATES');
    expect(wrapper.text()).toContain('90');
    expect(wrapper.text()).toContain('1,000');
  });

  it('shows a loading message before stats arrive', () => {
    const wrapper = mount(StatsGrid, { props: { stats: null } });
    expect(wrapper.text()).toContain('Loading stats');
  });
});
