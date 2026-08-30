<script setup lang="ts">
import { onMounted } from 'vue';
import { useDashboardStore } from './store';
import StatusIcons from './components/StatusIcons.vue';
import StatsGrid from './components/StatsGrid.vue';
import LogsPanel from './components/LogsPanel.vue';

const store = useDashboardStore();

onMounted(() => store.connect());
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6">
    <header class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-semibold">cadet-brainstem</h1>
      <span v-if="store.connected" class="text-xs text-emerald-400">live</span>
    </header>

    <StatusIcons :services="store.status" />
    <StatsGrid :stats="store.stats" />
    <LogsPanel :logs="store.logs" :traces="store.traces" />
  </div>
</template>
