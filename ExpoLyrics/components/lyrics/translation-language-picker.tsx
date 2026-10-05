import Ionicons from '@react-native-vector-icons/ionicons';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';

import { MotionPressable } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';
import { searchTranslationLanguages, TRANSLATION_LANGUAGE_NAMES, type TranslationLanguage } from '@/lib/translation-settings';

type Props = {
  open: boolean;
  selected: TranslationLanguage;
  onSelect: (language: TranslationLanguage) => void;
  onClose: () => void;
};

export function TranslationLanguagePicker({ open, selected, onSelect, onClose }: Props) {
  const reduceMotion = useReducedMotion();
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput>(null);
  const list = useRef<ScrollView>(null);
  useEffect(() => {
    if (open) {
      setSearch('');
      setFocused(false);
      list.current?.scrollTo({ y: 0, animated: false });
    }
  }, [open]);
  const searching = search.trim().length > 0;
  const matches = searchTranslationLanguages(search);
  const languages = searching ? matches : matches.filter(language => language !== selected);
  const close = () => { Keyboard.dismiss(); onClose(); };
  const row = (language: TranslationLanguage) => {
    const checked = language === selected;
    const nativeName = TRANSLATION_LANGUAGE_NAMES[language];
    return (
      <MotionPressable key={language} accessibilityRole="radio"
        accessibilityLabel={`${language}${nativeName !== language ? `, ${nativeName}` : ''}`}
        accessibilityState={{ checked }} aria-checked={checked}
        onPress={() => { onSelect(language); close(); }}
        style={({ pressed, hovered }) => [styles.row, checked && styles.selectedRow, (pressed || hovered) && styles.rowHover]}>
        <View style={styles.rowCopy}>
          <Text style={[styles.language, checked && styles.selectedText]}>{language}</Text>
          {nativeName !== language && <Text style={styles.nativeName}>{nativeName}</Text>}
        </View>
        {checked ? <View style={styles.check}><Ionicons name="checkmark" size={16} color={Design.accentInk} /></View>
          : <View style={styles.radio} />}
      </MotionPressable>
    );
  };
  return (
    <Modal visible={open} transparent animationType={reduceMotion ? 'none' : 'fade'} statusBarTranslucent
      supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
      onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessible={false} />
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']} pointerEvents="box-none">
          <KeyboardAvoidingView style={styles.positioner} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} pointerEvents="box-none">
            <View style={styles.panel} accessibilityViewIsModal onAccessibilityEscape={close}>
              <BlurView pointerEvents="none" intensity={34} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={styles.header}>
                <View style={styles.headingCopy}>
                  <Text style={styles.eyebrow}>LYRICS TRANSLATION</Text>
                  <Text accessibilityRole="header" style={styles.title}>Choose a language</Text>
                </View>
                <MotionPressable onPress={close} accessibilityLabel="Close language picker"
                  style={({ pressed, hovered }) => [styles.iconButton, (pressed || hovered) && styles.iconButtonHover]}>
                  <Ionicons name="close" size={22} color={Design.text} />
                </MotionPressable>
              </View>
              <Text style={styles.hint}>Used the next time you translate lyrics.</Text>
              <View style={[styles.search, focused && styles.searchFocused]}>
                <Ionicons name="search" size={20} color={focused ? Design.accent : Design.muted} />
                <TextInput ref={input} accessibilityLabel="Search languages" placeholder="Search languages"
                  placeholderTextColor={Design.muted} value={search}
                  onChangeText={value => { setSearch(value); list.current?.scrollTo({ y: 0, animated: false }); }}
                  onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                  autoCapitalize="none" autoCorrect={false} selectionColor={Design.accent}
                  returnKeyType="search" style={styles.searchInput} />
                {!!search && <MotionPressable accessibilityLabel="Clear language search" style={styles.clearButton}
                  onPress={() => { setSearch(''); input.current?.focus(); }}>
                  <Ionicons name="close-circle" size={20} color={Design.muted} />
                </MotionPressable>}
              </View>
              <ScrollView ref={list} style={styles.list} contentContainerStyle={styles.listContent}
                accessibilityRole="radiogroup" accessibilityLabel="Translation language" showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
                {!searching && <>
                  <Text style={styles.sectionLabel}>CURRENT LANGUAGE</Text>
                  {row(selected)}
                </>}
                <Text style={styles.sectionLabel} accessibilityLiveRegion="polite">
                  {searching ? `${languages.length} ${languages.length === 1 ? 'RESULT' : 'RESULTS'}` : 'ALL LANGUAGES'}
                </Text>
                {languages.map(row)}
                {languages.length === 0 && <View style={styles.empty}>
                  <Ionicons name="search-outline" size={28} color={Design.muted} />
                  <Text style={styles.emptyTitle}>No languages found</Text>
                  <Text style={styles.emptyHint}>Try an English or native language name.</Text>
                  <MotionPressable onPress={() => { setSearch(''); input.current?.focus(); }} style={styles.resetButton}>
                    <Text style={styles.selectedText}>Clear search</Text>
                  </MotionPressable>
                </View>}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(3,4,10,0.34)' },
  safeArea: { flex: 1 },
  positioner: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  panel: { width: '100%', maxWidth: 460, maxHeight: '90%', flexShrink: 1, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(9,12,19,0.28)', overflow: 'hidden', paddingTop: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20 },
  headingCopy: { flex: 1, minWidth: 0, gap: 6 },
  eyebrow: { color: Design.accent, fontSize: 10, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: Design.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  iconButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  iconButtonHover: { backgroundColor: 'rgba(255,255,255,0.18)' },
  hint: { color: Design.muted, fontSize: 13, lineHeight: 20, marginHorizontal: 20, marginTop: 10, marginBottom: 20 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 20, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(255,255,255,0.06)', paddingLeft: 14, paddingRight: 4, minHeight: 52 },
  searchFocused: { borderColor: Design.accent },
  searchInput: { flex: 1, minWidth: 0, color: Design.text, fontSize: 15, paddingVertical: 14, ...Platform.select({ web: { outlineWidth: 0 } }) },
  clearButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  list: { flexShrink: 1, marginTop: 8 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20, gap: 4 },
  sectionLabel: { color: Design.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.3, marginTop: 16, marginBottom: 6, marginHorizontal: 8 },
  row: { minHeight: 60, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 12, borderWidth: 1, borderColor: 'transparent' },
  selectedRow: { backgroundColor: 'rgba(168,240,207,0.08)', borderColor: 'rgba(168,240,207,0.3)' },
  rowHover: { backgroundColor: 'rgba(255,255,255,0.08)' },
  rowCopy: { flex: 1, minWidth: 0, gap: 4 },
  language: { color: Design.text, fontSize: 15, fontWeight: '600' },
  nativeName: { color: Design.muted, fontSize: 13, lineHeight: 20, writingDirection: 'auto' },
  selectedText: { color: Design.accent, fontWeight: '600' },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: Design.accent, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: Design.border },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 28 },
  emptyTitle: { color: Design.text, fontWeight: '600', fontSize: 17 },
  emptyHint: { color: Design.muted, fontSize: 13, textAlign: 'center' },
  resetButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: 'rgba(168,240,207,0.08)', marginTop: 4 },
});
