<script setup lang="ts">
import type { StatsPayload } from '../types';

defineProps<{ stats: StatsPayload | null }>();

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}
</script>

<template>
  <section class="mb-6" data-testid="stats-grid">
    <template v-if="stats">
      <p class="text-xs text-amber-300 mb-2">All figures are ESTIMATES</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-zinc-900 rounded p-4">
          <div class="text-xs text-zinc-400">Events</div>
          <div class="text-2xl font-semibold">{{ fmt(stats.totals.eventCount) }}</div>
        </div>
        <div class="bg-zinc-900 rounded p-4">
          <div class="text-xs text-zinc-400">Input tokens</div>
          <div class="text-2xl font-semibold">{{ fmt(stats.totals.inputTokens) }}</div>
        </div>
        <div class="bg-zinc-900 rounded p-4">
          <div class="text-xs text-zinc-400">Output tokens</div>
          <div class="text-2xl font-semibold">{{ fmt(stats.totals.outputTokens) }}</div>
        </div>
        <div class="bg-zinc-900 rounded p-4">
          <div class="text-xs text-zinc-400">Tokens saved</div>
          <div class="text-2xl font-semibold text-emerald-400">
            {{ fmt(stats.totals.tokensSaved) }}
          </div>
        </div>
      </div>
      <div class="mt-4 text-sm">
        <span class="text-zinc-400">Reduction:</span>
        <span class="ml-2">{{ stats.totals.reductionPct }}%</span>
        <span v-if="stats.totals.avgCompressionRatio !== null" class="ml-4 text-zinc-400">
          Avg compression:
        </span>
        <span v-if="stats.totals.avgCompressionRatio !== null" class="ml-2">
          {{ stats.totals.avgCompressionRatio.toFixed(2) }}
        </span>
      </div>
    </template>
    <p v-else class="text-zinc-500">Loading stats…</p>
  </section>
</template>
