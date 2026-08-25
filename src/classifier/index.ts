export {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_OLLAMA_HOST,
  ClassifierUnavailableError,
  OllamaClassifier,
  buildPrompt,
  classify,
  isOllamaAvailable,
} from './ollama';
export {
  ClassificationValidationError,
  classificationSchema,
  complexitySchema,
  contextNeedSchema,
  parseClassification,
  precisionSchema,
  riskSchema,
  taskTypeSchema,
} from './schema';
export type { ClassifierOptions } from './ollama';
export type {
  Classification,
  Complexity,
  ContextNeed,
  Precision,
  Risk,
  TaskType,
} from './schema';
