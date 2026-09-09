// AppLoader — the web app's fullscreen loader (frontend/components/cfo/
// AppLoader.tsx: the mark, a slim sweeping bar, one line of copy) drawn
// natively, so the shell shows ONE loader (2026-09-10 per operator): this
// one until the page's own paints, then the page's, identical, takes over.

import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { Palette } from "./theme";

type Props = {
  palette: Palette;
  accent: string;
  /** The line under the bar. Default matches the web loader's. */
  label?: string;
  /** Sheet-sized: smaller mark, no wordmark, no caption. */
  compact?: boolean;
};

const TRACK = 180;
const SLIVER = TRACK / 3;

/** The CFO AI mark (frontend/components/cfo/Mark.tsx), same geometry. */
export function Mark({ size, cFill, aFill }: { size: number; cFill: string; aFill: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Path d="M30 4 L4 20 L4 44 L30 60 L30 50 L14 41 L14 23 L30 14 Z" fill={cFill} />
      <Path d="M38 14 L60 60 L48 60 L38 38 Z" fill={aFill} />
      <Rect x={34} y={34} width={14} height={3} fill={aFill} />
    </Svg>
  );
}

export function AppLoader({ palette: p, accent, label = "Loading your workspace…", compact = false }: Props) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Same travel as the web's `app-loader-sweep`: -100% → 300% of the
    // sliver, 1.15 s, ease-in-out, forever.
    const loop = Animated.loop(
      Animated.timing(x, { toValue: 1, duration: 1150, easing: Easing.bezier(0.65, 0, 0.35, 1), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-SLIVER, SLIVER * 3] });
  const track = compact ? TRACK * 0.6 : TRACK;
  return (
    <View style={styles.body}>
      <View style={styles.logo}>
        <Mark size={compact ? 28 : 40} cFill={accent} aFill={p.text} />
        {!compact && (
          <Text style={[styles.wordmark, { color: p.text }]}>
            CFO <Text style={{ color: accent }}>AI</Text>
          </Text>
        )}
      </View>
      <View style={[styles.track, { width: track, backgroundColor: p.border }]}>
        <Animated.View style={[styles.sliver, { backgroundColor: accent, width: track / 3, transform: [{ translateX: compact ? Animated.multiply(translateX, 0.6) : translateX }] }]} />
      </View>
      {!compact && <Text style={[styles.caption, { color: p.textMute }]}>{label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: "center", gap: 20, paddingHorizontal: 24 },
  logo: { flexDirection: "row", alignItems: "center", gap: 10 },
  wordmark: { fontSize: 15, fontWeight: "500", letterSpacing: -0.1 },
  track: { height: 3, borderRadius: 2, overflow: "hidden" },
  sliver: { position: "absolute", top: 0, bottom: 0, borderRadius: 2, opacity: 0.9 },
  caption: { fontSize: 12.5, lineHeight: 18, textAlign: "center", maxWidth: 280 },
});
