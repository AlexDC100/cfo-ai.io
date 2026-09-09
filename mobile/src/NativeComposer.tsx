// NativeComposer — the Ask CFO AI message composer drawn NATIVELY in iOS 26
// Liquid Glass (2026-09-10 per operator), floating over the bottom of the
// WebView. The web page hides its own input inside the shell and drives
// this one through the `composer` message (placeholder, pending, disabled,
// draft); typing, Send and Stop go back as `cfo:native-action` events
// (composer-submit / composer-stop / composer-draft), and the measured
// height (composer-height) so the page pads its thread and places its
// "scroll to newest" arrow.
//
// It lives INSIDE the KeyboardAvoidingView, absolutely at its bottom, so
// it rides the keyboard's own animation exactly like the WebView's edge.

import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, StyleSheet, TextInput, TouchableOpacity, View, type ColorSchemeName } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import Svg, { Path, Rect } from "react-native-svg";
import type { Palette } from "./theme";

const LIQUID_GLASS = isLiquidGlassAvailable();
const LINE = 22;
const MAX_LINES = 7;

export type NativeComposerState = {
  show: boolean;
  placeholder?: string;
  pending?: boolean;
  disabled?: boolean;
  /** Text to show; resent with `key` whenever the open conversation changes. */
  draft?: string;
  key?: string;
};

type Props = {
  state: NativeComposerState;
  scheme: ColorSchemeName;
  palette: Palette;
  accent: string;
  /** Home-indicator inset (the composer keeps clear of it when the keyboard is down). */
  bottomInset: number;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onDraft: (text: string) => void;
  onHeight: (height: number) => void;
};

export function NativeComposer({ state, scheme, palette: p, accent, bottomInset, onSubmit, onStop, onDraft, onHeight }: Props) {
  const [text, setText] = useState(state.draft ?? "");
  const [lines, setLines] = useState(1);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A new conversation (or a draft the page restored) replaces the text.
  const keyRef = useRef(state.key);
  useEffect(() => {
    if (keyRef.current !== state.key) {
      keyRef.current = state.key;
      setText(state.draft ?? "");
    }
  }, [state.key, state.draft]);

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardUp(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => () => clearTimeout(draftTimer.current), []);

  if (!state.show) return null;

  const canSend = text.trim().length > 0 && !state.pending && !state.disabled;
  const dark = scheme === "dark";
  // Idle: sits a little above the home indicator; keyboard up: tight.
  const padBottom = keyboardUp ? 8 : Math.max(8, bottomInset - 6);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { paddingBottom: padBottom }]}
      onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height))}
    >
      <GlassView
        glassEffectStyle="regular"
        isInteractive
        colorScheme={dark ? "dark" : "light"}
        style={[
          styles.glass,
          !LIQUID_GLASS && {
            backgroundColor: dark ? "rgba(16, 24, 22, 0.85)" : "rgba(249, 249, 245, 0.88)",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
          },
        ]}
      >
        <View style={styles.row}>
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={(t) => {
              setText(t);
              clearTimeout(draftTimer.current);
              draftTimer.current = setTimeout(() => onDraft(t), 250);
            }}
            onContentSizeChange={(e) =>
              setLines(Math.max(1, Math.min(MAX_LINES, Math.round(e.nativeEvent.contentSize.height / LINE))))
            }
            placeholder={state.placeholder ?? "Ask CFO AI anything…"}
            placeholderTextColor={p.textMute}
            editable={!state.disabled}
            multiline
            keyboardAppearance={dark ? "dark" : "light"}
            style={[styles.input, { color: p.text, height: lines * LINE + 18 }]}
            accessibilityLabel="Ask CFO AI"
          />
          {state.pending ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Stop generating" onPress={onStop} style={[styles.send, { backgroundColor: accent }]} activeOpacity={0.8}>
              <Svg width={12} height={12} viewBox="0 0 12 12">
                <Rect x={1} y={1} width={10} height={10} rx={2} fill="#FFFFFF" />
              </Svg>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!canSend}
              onPress={() => {
                const t = text.trim();
                if (!t) return;
                onSubmit(t);
                setText("");
                setLines(1);
                clearTimeout(draftTimer.current);
                onDraft("");
              }}
              style={[styles.send, { backgroundColor: canSend ? accent : (dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)") }]}
              activeOpacity={0.8}
            >
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={canSend ? "#FFFFFF" : p.textMute} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M12 19V5" />
                <Path d="m5 12 7-7 7 7" />
              </Svg>
            </TouchableOpacity>
          )}
        </View>
      </GlassView>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  glass: {
    borderRadius: 24,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 4,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: LINE,
    paddingTop: 9,
    paddingBottom: 9,
    paddingHorizontal: 0,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
});
