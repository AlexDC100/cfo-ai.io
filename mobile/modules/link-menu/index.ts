// See ios/LinkMenuModule.swift. iOS only; a no-op elsewhere.
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

const native = Platform.OS === "ios"
  ? requireOptionalNativeModule<{ install(rename: string, remove: string, dark: boolean): void }>("LinkMenu")
  : null;

/** Give every mounted WKWebView the chat-row context menu (2026-09-10 per
 *  operator: "use the native iOS one"). A long-press on a link of the form
 *  /chat?c=<id>&t=<title> shows the system context menu — a preview of the
 *  row, then Rename and Delete — and every other link shows nothing. The
 *  actions come back to the page as `cfo:native-action` events
 *  chat-rename / chat-delete / chat-open with the row's id. Safe to call
 *  again: labels and theme are updated on the delegates already installed. */
export function installLinkMenu(labels: { rename: string; remove: string }, dark: boolean): void {
  native?.install(labels.rename, labels.remove, dark);
}
