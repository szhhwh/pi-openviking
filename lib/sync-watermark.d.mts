export declare function defaultWatermarkDir(): string;
export interface SyncWatermark {
  count: number;
  lastEntryId: string;
  ovSessionId: string;
}
export declare function loadWatermark(sessionId: string, dir?: string): SyncWatermark | null;
export declare function saveWatermark(
  sessionId: string,
  data?: { count?: number; lastEntryId?: string; ovSessionId?: string },
  dir?: string,
): boolean;
export declare function watermarkMatches(
  watermark: SyncWatermark | null,
  branch: any[],
  ovSessionId?: string,
): boolean;
