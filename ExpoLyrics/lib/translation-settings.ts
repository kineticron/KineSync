export const TRANSLATION_LANGUAGES = [
  "English",
  "Arabic",
  "Bengali",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Czech",
  "Danish",
  "Dutch",
  "Finnish",
  "French",
  "German",
  "Greek",
  "Hebrew",
  "Hindi",
  "Hungarian",
  "Indonesian",
  "Italian",
  "Japanese",
  "Korean",
  "Malay",
  "Norwegian",
  "Persian",
  "Polish",
  "Portuguese",
  "Romanian",
  "Russian",
  "Spanish",
  "Swedish",
  "Tamil",
  "Telugu",
  "Thai",
  "Turkish",
  "Ukrainian",
  "Urdu",
  "Vietnamese"
] as const;
export type TranslationLanguage = typeof TRANSLATION_LANGUAGES[number];

/** Display labels only: keep the English values used by storage and translation APIs. */
export const TRANSLATION_LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  English: 'English', Arabic: 'العربية', Bengali: 'বাংলা',
  'Chinese (Simplified)': '简体中文', 'Chinese (Traditional)': '繁體中文',
  Czech: 'Čeština', Danish: 'Dansk', Dutch: 'Nederlands', Finnish: 'Suomi',
  French: 'Français', German: 'Deutsch', Greek: 'Ελληνικά', Hebrew: 'עברית',
  Hindi: 'हिन्दी', Hungarian: 'Magyar', Indonesian: 'Bahasa Indonesia',
  Italian: 'Italiano', Japanese: '日本語', Korean: '한국어', Malay: 'Bahasa Melayu',
  Norwegian: 'Norsk', Persian: 'فارسی', Polish: 'Polski', Portuguese: 'Português',
  Romanian: 'Română', Russian: 'Русский', Spanish: 'Español', Swedish: 'Svenska',
  Tamil: 'தமிழ்', Telugu: 'తెలుగు', Thai: 'ไทย', Turkish: 'Türkçe',
  Ukrainian: 'Українська', Urdu: 'اردو', Vietnamese: 'Tiếng Việt',
};

export function searchTranslationLanguages(query: string): TranslationLanguage[] {
  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const search = normalize(query.trim());
  return TRANSLATION_LANGUAGES.filter(language =>
    normalize(`${language} ${TRANSLATION_LANGUAGE_NAMES[language]}`).includes(search),
  );
}
export function normalizeTranslationLanguage(value: unknown): TranslationLanguage {
  return TRANSLATION_LANGUAGES.includes(value as TranslationLanguage) ? value as TranslationLanguage : 'English';
}
