import type zhTW from './locales/zh-TW';

/** All valid translation keys (derived from zh-TW as the source of truth). */
export type TranslationKey = keyof typeof zhTW;

/** Supported locales. */
export type Locale = 'zh-TW' | 'zh-CN' | 'en';

/** Supported themes. */
export type Theme = 'dark' | 'light';

/** A translation dictionary must cover every key. */
export type TranslationDictionary = Record<TranslationKey, string>;
