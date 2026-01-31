import type { Response } from 'express';

export interface Paper {
  _id: string;
  url: string;
  title: string;
  authors: string;
  abstract: string;
  tags: string[];
  source: string;
  dateAdded: string;
  lastAccessed: string | null;
  accessCount: number;
}

export interface PaperInput {
  url: string;
  title?: string;
  authors?: string;
  abstract?: string;
  tags?: string[];
  source?: string;
}

export interface PaperUpdateInput {
  url?: string;
  title?: string;
  authors?: string;
  abstract?: string;
  tags?: string[];
}

export interface PaperMetadata {
  url: string;
  title: string;
  authors: string;
  abstract: string;
  source: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaperQuery {
  search?: string;
  tag?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

// LokiJS extended paper with internal fields
export interface LokiPaper extends Paper {
  $loki?: number;
  meta?: {
    created: number;
    revision: number;
    updated: number;
    version: number;
  };
}

// SSE Client type
export type SSEClient = Response;
