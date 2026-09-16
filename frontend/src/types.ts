// 前端类型定义（与后端对齐）

export interface MovieListItem {
  id: string;
  title: string;
  year: string;
  description: string;
  thumbnail: string;
  downloads: number;
  rating: number;
  subjects: string[];
  source?: string;
  sourceName?: string;
  remarks?: string;
}

export interface PlayableFile {
  name: string;
  format: string;
  size: number;
  length: string;
  url: string;
  mimetype: string;
}

export interface MovieDetail extends MovieListItem {
  creator: string;
  runtime: string;
  language: string;
  licenseUrl: string;
  actor?: string;
  playableFiles: PlayableFile[];
  sourceFiles: PlayableFile[];
}

export interface SourceInfo {
  key: string;
  name: string;
  type: 'archive' | 'vod';
}

export interface SourcesResponse {
  sources: SourceInfo[];
  defaultSource: string;
}

export interface VodCategory {
  typeId: number;
  typePid: number;
  typeName: string;
}

export interface CategoriesResponse {
  categories: VodCategory[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  rows: number;
}

export interface GlobalSearchResult extends PaginatedResult<MovieListItem> {
  sourcesHit: number;
  sourcesTotal: number;
  hasMore: boolean;
}
