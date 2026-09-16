// 后端类型定义

/** archive.org 搜索结果中的文档（部分字段） */
export interface ArchiveSearchDoc {
  identifier: string;
  title?: string;
  description?: string[] | string;
  year?: string;
  creator?: string[] | string;
  subject?: string[] | string;
  downloads?: number;
  avg_rating?: number;
  num_reviews?: number;
  collection?: string[] | string;
}

/** archive.org 搜索响应 */
export interface ArchiveSearchResponse {
  response: {
    numFound: number;
    start: number;
    docs: ArchiveSearchDoc[];
  };
}

/** archive.org metadata 接口返回的文件项 */
export interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
  length?: string;
  mimetype?: string;
  width?: string;
  height?: string;
  source?: string;
}

/** archive.org metadata 接口响应 */
export interface ArchiveMetadataResponse {
  metadata: {
    title?: string;
    description?: string;
    year?: string;
    creator?: string[] | string;
    subject?: string[] | string;
    runtime?: string;
    language?: string;
    collection?: string[] | string;
    licenseurl?: string;
  };
  files?: ArchiveFile[];
  server?: string;
  dir?: string;
}

/** 对外暴露的影视列表项（已规整） */
export interface MovieListItem {
  id: string;
  title: string;
  year: string;
  description: string;
  thumbnail: string;
  downloads: number;
  rating: number;
  subjects: string[];
  /** VOD 资源站 key，archive 源无此字段 */
  source?: string;
  sourceName?: string;
  remarks?: string;
}

/** 对外暴露的影视详情（已规整） */
export interface MovieDetail extends MovieListItem {
  creator: string;
  runtime: string;
  language: string;
  licenseUrl: string;
  actor?: string;
  /** 可播放的视频文件（已筛选为浏览器友好格式） */
  playableFiles: PlayableFile[];
  /** 下载源文件 */
  sourceFiles: PlayableFile[];
}

/** 资源站信息 */
export interface SourceInfo {
  key: string;
  name: string;
  type: 'archive' | 'vod';
}

/** VOD 分类标签 */
export interface VodCategory {
  typeId: number;
  typePid: number;
  typeName: string;
}

export interface PlayableFile {
  name: string;
  format: string;
  size: number;
  length: string;
  url: string;
  mimetype: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  rows: number;
}

/** 全站聚合搜索结果 */
export interface GlobalSearchResult extends PaginatedResult<MovieListItem> {
  sourcesHit: number;
  sourcesTotal: number;
  hasMore: boolean;
}
