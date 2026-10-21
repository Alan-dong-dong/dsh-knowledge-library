export type MaterialKind = 'text' | 'web' | 'file' | 'video' | 'transcript' | 'note';
export type MaterialStatus = 'ready' | 'stored';
export interface Citation { materialId: string; segmentId?: string }
export interface Segment {
  id: string;
  text: string;
  startSeconds?: number;
  endSeconds?: number;
}
export interface Material {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: MaterialKind;
  status: MaterialStatus;
  category: string;
  tags: string[];
  collection: string;
  sourceUrl?: string;
  sourceNote: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deletionId?: string;
  knowledgeJobId?: string;
  contentHash: string;
  textChecksum?: string;
  segmentsChecksum?: string;
  revision: 1;
  originalName?: string;
  originalFile?: string;
  citations: Citation[];
  extraction: string;
}
export interface MaterialDetail extends Material {
  content: string;
  segments: Segment[];
  path: string;
}
export interface TrashSnapshot { count: number; pending: number; token: string }
export interface EmptyTrashResult { deleted: number; pending: number; errors: string[] }
export interface CaptureFields {
  title?: string;
  category?: string;
  tags?: string[];
  collection?: string;
  sourceUrl?: string;
  sourceNote?: string;
}
export interface SearchOptions {
  query?: string;
  category?: string;
  tag?: string;
  collection?: string;
  kind?: string;
  trashed?: boolean;
  limit?: number;
  offset?: number;
}
export interface SearchResult extends Material {
  excerpt: string;
  matches: Array<Segment & { citation: string }>;
}
export interface CaptureResult { material: MaterialDetail; duplicate: boolean }
export interface ImportJob {
  id: string;
  url: string;
  fields: CaptureFields;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  attempts: number;
  materialId?: string;
  error?: string;
  errorCode?: 'PAGE_REQUIRES_BROWSER';
}
export interface KnowledgeDraft {
  title: string;
  content: string;
  tags: string[];
  citations: Citation[];
  category?: string;
}
export interface KnowledgeSource { id: string; title: string; fingerprint: string; category?: string; tags?: string[] }
export interface SourceAnalysis {
  sourceId: string;
  theme: string;
  concepts: string[];
  summary: string;
  usage: string;
  category: string;
  tags: string[];
  certainty: 'clear' | 'uncertain';
  uncertainty: string;
  citations: Citation[];
}
export interface KnowledgeGroup { id: string; title: string; reason: string; sourceIds: string[]; category: string; tags: string[] }
export interface GroupingPlan { groups: KnowledgeGroup[]; unassigned: Array<{ sourceId: string; reason: string }>; applyClassification?: boolean }
export interface ClassificationStep { sourceId: string; before: { category: string; tags: string[] }; after: { category: string; tags: string[] }; done: boolean }
export interface ClassificationJournal { apply: boolean; version: number; direction: 'apply' | 'rollback'; steps: ClassificationStep[] }
export interface KnowledgeJob {
  id: string;
  sourceIds: string[];
  sources: KnowledgeSource[];
  topic: string;
  status: 'queued' | 'running' | 'grouping' | 'classifying' | 'grouped' | 'draft' | 'completed' | 'failed' | 'cancelled' | 'discarded';
  mode?: 'compose' | 'smart';
  parentId?: string;
  groupId?: string;
  analyses?: SourceAnalysis[];
  plan?: GroupingPlan;
  planVersion?: number;
  classification?: ClassificationJournal;
  children?: Array<{ groupId: string; jobId: string }>;
  createdAt: string;
  updatedAt: string;
  progress: string;
  model?: string;
  modelCalls?: number;
  error?: string;
  draft?: KnowledgeDraft;
  draftVersion: number;
  noteId?: string;
}
export interface KnowledgeState {
  status: 'pending' | 'running' | 'grouping' | 'draft' | 'completed' | 'failed';
  jobId?: string;
  noteIds: string[];
}
export interface KnowledgeOverview {
  supported: boolean;
  smartSupported?: boolean;
  available: boolean;
  model?: string;
  reason?: string;
  jobs: KnowledgeJob[];
  states: Record<string, KnowledgeState>;
}
