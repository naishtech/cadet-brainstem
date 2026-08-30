<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { DashboardEvent } from '../types';
import type { Trace } from '../store';
import LlmTraceView from './LlmTraceView.vue';

const props = defineProps<{ logs: DashboardEvent[]; traces: Trace[] }>();

type Tab = 'all' | 'request' | 'response' | 'llm';

const tabs: Tab[] = ['all', 'request', 'response', 'llm'];
const tab = ref<Tab>('all');
const paused = ref(false);
const scroller = ref<HTMLElement | null>(null);

const visible = computed<DashboardEvent[]>(() => {
  if (tab.value === 'all') return props.logs;
  return props.logs.filter((event) => event.type === tab.value);
});

watch(visible, async () => {
  if (!paused.value) {
    await nextTick();
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  }
});

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function statusSummary(
  event: Extract<DashboardEvent, { type: 'status' }>,
): string {
  return event.services
    .map((service) => `${service.kind}:${service.available ? 'up' : 'down'}`)
    .join(' · ');
}
</script>

<template>
  <section data-testid="logs-panel">
    <div class="flex items-center gap-2 mb-2">
      <button
        v-for="t in tabs"
        :key="t"
        :class="tab === t ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400'"
        class="px-3 py-1 rounded text-sm capitalize"
        @click="tab = t"
      >
        {{ t }}
      </button>
      <button class="ml-auto text-xs text-zinc-400" @click="paused = !paused">
        {{ paused ? 'resume' : 'pause' }}
      </button>
    </div>

    <div
      ref="scroller"
      class="h-64 overflow-y-auto bg-zinc-900 rounded p-3 text-xs font-mono"
    >
      <LlmTraceView v-if="tab === 'llm'" :traces="traces" />
      <template v-else>
        <div v-if="visible.length === 0" class="text-zinc-500">
          No {{ tab }} events yet.
        </div>
        <div
          v-for="(event, index) in visible"
          :key="index"
          class="py-1 border-b border-zinc-800"
        >
          <span class="text-zinc-500">{{ time(event.ts) }}</span>
          <span class="ml-2">{{ event.type }}</span>
          <span v-if="event.type === 'log'" class="ml-2 text-zinc-300">
            {{ (event as Extract<DashboardEvent, { type: 'log' }>).message }}
          </span>
          <span v-else-if="event.type === 'request'" class="ml-2 text-zinc-300">
            {{ (event as Extract<DashboardEvent, { type: 'request' }>).operation }}
          </span>
          <span
            v-else-if="event.type === 'response'"
            class="ml-2"
            :class="
              (event as Extract<DashboardEvent, { type: 'response' }>).ok
                ? 'text-emerald-400'
                : 'text-red-400'
            "
          >
            {{ (event as Extract<DashboardEvent, { type: 'response' }>).ok ? 'ok' : 'fail' }}
          </span>
          <span v-else-if="event.type === 'status'" class="ml-2 text-zinc-300">
            {{ statusSummary(event as Extract<DashboardEvent, { type: 'status' }>) }}
          </span>
        </div>
      </template>
    </div>
  </section>
</template>
