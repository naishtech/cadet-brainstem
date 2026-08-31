<script setup lang="ts">
import { defineProps } from 'vue';

defineProps<{
  traces: Array<{
    id: string;
    model: string;
    tokens: string;
    thinking: string;
    complete: boolean;
  }>;
}>();
</script>

<template>
  <div data-testid="llm-trace">
    <div v-if="traces.length === 0" class="text-zinc-500">No LLM traces yet.</div>
    <details
      v-for="trace in traces"
      :key="trace.id"
      class="py-1 border-b border-zinc-800"
      open
    >
      <summary class="cursor-pointer text-zinc-300">
        {{ trace.model }}
        <span :class="trace.complete ? 'text-emerald-400' : 'text-amber-300'">
          {{ trace.complete ? 'done' : 'thinking…' }}
        </span>
      </summary>
      <details v-if="trace.thinking" class="mt-1">
        <summary class="cursor-pointer text-xs text-amber-400/70 uppercase tracking-wide">
          Thinking
        </summary>
        <pre class="mt-1 text-amber-300/80 whitespace-pre-wrap">{{ trace.thinking }}</pre>
      </details>
      <pre class="mt-1 text-emerald-300 whitespace-pre-wrap">{{ trace.tokens }}</pre>
    </details>
  </div>
</template>
