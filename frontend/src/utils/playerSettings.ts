const STORAGE_KEY = 'pdc-player-settings-v1';

export interface PlayerSettings {
  /** 片头跳过时长（秒） */
  introSkipSeconds: number;
  /** 片尾跳过时长（秒） */
  outroSkipSeconds: number;
}

const DEFAULTS: PlayerSettings = {
  introSkipSeconds: 90,
  outroSkipSeconds: 90,
};

function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(600, Math.round(value)));
}

export function getPlayerSettings(): PlayerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PlayerSettings>;
    return {
      introSkipSeconds: clampSeconds(parsed.introSkipSeconds ?? DEFAULTS.introSkipSeconds),
      outroSkipSeconds: clampSeconds(parsed.outroSkipSeconds ?? DEFAULTS.outroSkipSeconds),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePlayerSettings(partial: Partial<PlayerSettings>): PlayerSettings {
  const current = getPlayerSettings();
  const next: PlayerSettings = {
    introSkipSeconds: clampSeconds(partial.introSkipSeconds ?? current.introSkipSeconds),
    outroSkipSeconds: clampSeconds(partial.outroSkipSeconds ?? current.outroSkipSeconds),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
