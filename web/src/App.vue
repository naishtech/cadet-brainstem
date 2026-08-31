<script setup lang="ts">
import { onMounted } from 'vue';
import { useDashboardStore } from './store';
import StatusIcons from './components/StatusIcons.vue';
import StatsGrid from './components/StatsGrid.vue';
import LogsPanel from './components/LogsPanel.vue';
import logo from './images/logo_64x64.png';

const store = useDashboardStore();

onMounted(() => store.connect());
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6">
    <header class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-3">
        <img :src="logo" alt="cadet-brainstem logo" class="h-8 w-8" />
        <h1 class="text-xl font-semibold">cadet-brainstem</h1>
      </div>
      <span v-if="store.connected" class="text-xs text-emerald-400">live</span>
    </header>

    <StatusIcons :services="store.status" />
    <StatsGrid :stats="store.stats" />
    <LogsPanel
      :logs="store.logs"
      :traces="store.traces"
      :steering-logs="store.steeringLogs"
      :procedure-logs="store.procedureLogs"
      :steering-traces="store.steeringTraces"
      :procedure-traces="store.procedureTraces"
    />
  </div>
</template>
