// See ios/KeyboardInsetsModule.swift. iOS only; a no-op elsewhere.
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

const native = Platform.OS === "ios" ? requireOptionalNativeModule<{ enforce(): void; debug(): string }>("KeyboardInsets") : null;

/** Zero the keyboard content inset on every mounted WKWebView (and keep it
 *  zero). Call after a WebView mounts; the module also re-runs on every
 *  keyboard notification by itself. */
export function enforceKeyboardInsets(): void {
  native?.enforce();
}

export function debugKeyboardInsets(): string {
  return native ? native.debug() : "module missing";
}
