// Generated from @applemusic-like-lyrics/core utils/is-cjk.ts (AGPL-3.0-only).
// Regenerate with node scripts/extract-amll-native-layout.cjs. Do not fit a different wrapping policy.
export const isCJK = (char: string): boolean => {
	return /^[\p{Unified_Ideograph}\u0800-\u9FFC]+$/u.test(char);
};
