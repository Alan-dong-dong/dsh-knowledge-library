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
}
