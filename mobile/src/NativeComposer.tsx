// NativeComposer — the Ask CFO AI message composer drawn NATIVELY in iOS 26
// Liquid Glass (2026-09-10 per operator), floating over the bottom of the
// WebView. The web page hides its own input inside the shell and drives
// this one through the `composer` message (placeholder, pending, disabled,
// draft, arrow); typing, Send, Stop, the paperclip and the arrow go back
// as `cfo:native-action` events (composer-submit / composer-stop /
// composer-draft / composer-attach / composer-scroll), plus the measured
// height (composer-height) so the page pads its thread.
//
// It is absolutely positioned inside the view that the KeyboardAvoidingView
// pads, so its bottom edge is the keyboard's top edge while the keyboard is
// up (an absolute child of the avoiding view itself would ignore that
// padding and sit under the keyboard).

import { useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Platform, StyleSheet, TextInput, TouchableOpacity, View, type ColorSchemeName } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { Palette } from "./theme";

const LIQUID_GLASS = isLiquidGlassAvailable();
const LINE = 22;
const MAX_LINES = 7;
// Room above the glass for the "scroll to newest" disc, which floats a
// clear gap above the composer (2026-09-10 per operator). Not part of the
// height reported to the page.
const ARROW = 36;
const ARROW_GAP = 14;
const ARROW_ROOM = ARROW + ARROW_GAP;

export type NativeComposerState = {
  show: boolean;
  placeholder?: string;
  pending?: boolean;
  disabled?: boolean;
  /** Text to show; resent with `key` whenever the open conversation changes. */
  draft?: string;
  key?: string;
  /** There is more of the thread below the viewport — show the arrow. */
  arrow?: boolean;
  /** The general-answer disclosure behind the ⓘ button. */
  info?: string;
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
  onAttach: () => void;
  onScroll: () => void;
  onHeight: (height: number) => void;
};

function glassFallback(dark: boolean, border: string) {
  return LIQUID_GLASS
    ? null
    : {
        backgroundColor: dark ? "rgba(16, 24, 22, 0.85)" : "rgba(249, 249, 245, 0.88)",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: border,
      };
}

export function NativeComposer({ state, scheme, palette: p, accent, bottomInset, onSubmit, onStop, onDraft, onAttach, onScroll, onHeight }: Props) {
  const [text, setText] = useState(state.draft ?? "");
  const [keyboardUp, setKeyboardUp] = useState(false);
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
  const fallback = glassFallback(dark, p.border);
  // Idle: clear of the home indicator (raised 8 pt 2026-09-10 per
  // operator); keyboard up: tight on it.
  const padBottom = keyboardUp ? 8 : Math.max(16, bottomInset + 2);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { paddingBottom: padBottom }]}
      onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height) - ARROW_ROOM)}
    >
      {state.arrow && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Scroll to newest message"
          onPress={onScroll}
          style={styles.arrowHit}
          activeOpacity={0.85}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <GlassView glassEffectStyle="regular" isInteractive colorScheme={dark ? "dark" : "light"} style={[styles.arrow, fallback]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={p.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 5v14" />
              <Path d="m19 12-7 7-7-7" />
            </Svg>
          </GlassView>
        </TouchableOpacity>
      )}
      {/* "regular" glass, the burger's material, plus a tint (2026-09-10
          per operator, from a screenshot): iOS renders regular glass on a
          panel this size almost as the page colour, while the 44 pt discs
          read as a lighter lift — the tint brings the panel up to them. */}
      <GlassView
        glassEffectStyle="regular"
        isInteractive
        colorScheme={dark ? "dark" : "light"}
        tintColor={dark ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.35)"}
        style={[styles.glass, fallback]}
      >
        {/* Row 1: the message on its own line. Row 2: attach · ⓘ on the
            left, Send on the right (2026-09-10 per operator). The field
            auto-grows between one and MAX_LINES lines with NO explicit
            height: feeding onContentSizeChange back into `height` made
            iOS report the new bounds as the next content size, so the
            composer crept up and down on its own. */}
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            clearTimeout(draftTimer.current);
            draftTimer.current = setTimeout(() => onDraft(t), 250);
          }}
          placeholder={state.placeholder ?? "Ask CFO AI anything…"}
          placeholderTextColor={p.textMute}
          editable={!state.disabled}
          multiline
          keyboardAppearance={dark ? "dark" : "light"}
          style={[styles.input, { color: p.text }]}
          accessibilityLabel="Ask CFO AI"
        />
        <View style={styles.toolbar}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Attach a file"
            onPress={onAttach}
            disabled={!!state.disabled}
            style={styles.iconButton}
            activeOpacity={0.7}
          >
            <Svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={p.textMute} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <Path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </Svg>
          </TouchableOpacity>
          {!!state.info && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="About CFO AI answers"
              onPress={() => Alert.alert("", state.info, [{ text: "OK" }], { userInterfaceStyle: dark ? "dark" : "light" })}
              style={styles.iconButton}
              activeOpacity={0.7}
            >
              <Svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={p.textMute} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={12} cy={12} r={10} />
                <Path d="M12 16v-4" />
                <Path d="M12 8h.01" />
              </Svg>
            </TouchableOpacity>
          )}
          <View style={styles.spacer} />
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
    paddingTop: ARROW_ROOM,
  },
  arrowHit: {
    position: "absolute",
    top: 0,
    left: "50%",
    marginLeft: -ARROW / 2,
    width: ARROW,
    height: ARROW,
  },
  arrow: {
    width: ARROW,
    height: ARROW,
    borderRadius: ARROW / 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  glass: {
    borderRadius: 22,
    overflow: "hidden",
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 6,
    paddingRight: 6,
    paddingBottom: 6,
    gap: 2,
  },
  spacer: { flex: 1 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    fontSize: 16,
    lineHeight: LINE,
    paddingTop: 10,
    paddingBottom: 4,
    paddingHorizontal: 16,
    minHeight: LINE + 14,
    maxHeight: MAX_LINES * LINE + 14,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
