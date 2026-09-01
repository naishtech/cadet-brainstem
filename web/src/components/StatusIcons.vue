<script setup lang="ts">
import type { ToolStatus } from '../types';

defineProps<{ services: ToolStatus[] }>();

const KIND_LABEL: Record<string, string> = {
  llm: 'LLM',
  serena: 'SERENA',
  leanctx: 'LEANCTX',
};

function label(kind: string): string {
  return KIND_LABEL[kind] ?? kind.toUpperCase();
}

function dotClass(available: boolean): string {
  return available ? 'bg-emerald-400' : 'bg-red-400';
}
</script>

<template>
  <div class="flex flex-wrap gap-4 mb-6" data-testid="status-icons">
    <div
      v-for="service in services"
      :key="service.kind"
      class="flex items-center gap-2 bg-zinc-900 rounded px-3 py-2"
      :title="service.detail ?? service.name"
      :data-kind="service.kind"
      :data-available="String(service.available)"
    >
      <span
        class="inline-block w-3 h-3 rounded-full"
        :class="dotClass(service.available)"
      ></span>
      <span class="text-sm">{{ label(service.kind) }}</span>
      <span v-if="service.detail" class="text-xs text-zinc-500"
        >[{{ service.detail }}]</span
      >
    </div>
  </div>
</template>
