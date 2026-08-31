<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { DashboardEvent } from '../types';
import type { Trace } from '../store';
import LlmTraceView from './LlmTraceView.vue';

const props = defineProps<{
  logs: DashboardEvent[];
  traces: Trace[];
  steeringLogs: DashboardEvent[];
  procedureLogs: DashboardEvent[];
  steeringTraces: Trace[];
  procedureTraces: Trace[];
}>();

type Tab = 'all' | 'steering' | 'procedures';

const tabs: Tab[] = ['all', 'steering', 'procedures'];
const tab = ref<Tab>('all');
const paused = ref(false);
const scroller = ref<HTMLElement | null>(null);

const visibleLogs = computed<DashboardEvent[]>(() => {
  switch (tab.value) {
    case 'steering':
      return props.steeringLogs;
    case 'procedures':
      return props.procedureLogs;
    default:
      return props.logs;
  }
});

const visibleTraces = computed<Trace[]>(() => {
  switch (tab.value) {
    case 'steering':
      return props.steeringTraces;
    case 'procedures':
      return props.procedureTraces;
    default:
      return props.traces;
  }
});

watch([visibleLogs, visibleTraces], async () => {
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
      <LlmTraceView v-if="visibleTraces.length > 0" :traces="visibleTraces" />
      <template v-if="visibleLogs.length > 0">
        <div
          v-for="(event, index) in visibleLogs"
          :key="index"
          class="py-1 border-b border-zinc-800"
        >
          <span class="text-zinc-500">{{ time(event.ts) }}</span>
          <span class="ml-2 text-zinc-500">{{ event.type }}</span>
          <template v-if="event.type === 'log'">
            <span class="ml-2 text-zinc-300">
              {{ (event as Extract<DashboardEvent, { type: 'log' }>).message }}
            </span>
          </template>
          <template v-else-if="event.type === 'request'">
            <span class="ml-2 text-sky-300">
              {{ (event as Extract<DashboardEvent, { type: 'request' }>).tool }}
            </span>
            <span class="ml-2 text-zinc-200 font-semibold">
              {{ (event as Extract<DashboardEvent, { type: 'request' }>).operation }}
            </span>
            <details
              v-if="(event as Extract<DashboardEvent, { type: 'request' }>).inputHint"
              class="inline-block ml-2 align-middle text-zinc-400"
            >
              <summary class="inline-block cursor-pointer select-none">request</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all bg-zinc-950 rounded p-2 text-zinc-200">{{
                (event as Extract<DashboardEvent, { type: 'request' }>).inputHint
              }}</pre>
            </details>
          </template>
          <template v-else-if="event.type === 'response'">
            <span
              class="ml-2"
              :class="
                (event as Extract<DashboardEvent, { type: 'response' }>).ok
                  ? 'text-emerald-400'
                  : 'text-red-400'
              "
            >
              {{ (event as Extract<DashboardEvent, { type: 'response' }>).ok ? 'ok' : 'fail' }}
            </span>
            <span
              v-if="(event as Extract<DashboardEvent, { type: 'response' }>).latencyMs !== undefined"
              class="ml-2 text-zinc-500"
            >
              {{ (event as Extract<DashboardEvent, { type: 'response' }>).latencyMs }}ms
            </span>
            <details
              v-if="(event as Extract<DashboardEvent, { type: 'response' }>).outputHint"
              class="inline-block ml-2 align-middle text-zinc-400"
            >
              <summary class="inline-block cursor-pointer select-none">response</summary>
              <pre class="mt-1 whitespace-pre-wrap break-all bg-zinc-950 rounded p-2 text-zinc-200">{{
                (event as Extract<DashboardEvent, { type: 'response' }>).outputHint
              }}</pre>
            </details>
          </template>
          <template v-else-if="event.type === 'status'">
            <span class="ml-2 text-zinc-300">
              {{ statusSummary(event as Extract<DashboardEvent, { type: 'status' }>) }}
            </span>
          </template>
        </div>
      </template>
      <div
        v-if="visibleLogs.length === 0 && visibleTraces.length === 0"
        class="text-zinc-500"
      >
        No {{ tab }} events yet.
      </div>
    </div>
  </section>
</template>
