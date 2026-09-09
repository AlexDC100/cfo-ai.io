// KeyboardInsets — keeps every WKWebView's scroll view free of the content
// inset WebKit adds for the on-screen keyboard (2026-09-09 per operator).
//
// The shell already shrinks the WebView above the keyboard with a
// KeyboardAvoidingView so the web app's `position: fixed; bottom: 0` chat
// composer sits exactly on the keyboard. WKWebView independently insets its
// UIScrollView by the keyboard's height (UIKeyboardWillShow →
// _adjustForAutomaticKeyboardInfo), and the two stack: the page could be
// dragged a whole keyboard height past its content, with the composer
// riding up and away. On current iOS the keyboard part arrives as a
// SYSTEM inset (visible only in adjustedContentInset — contentInset and
// safeAreaInsets both read zero), so it is cancelled with an equal negative
// contentInset, re-applied whenever WebKit or the WebView's own layout
// pass resets it, and cleared again when the keyboard goes.

import ExpoModulesCore
import WebKit

public class KeyboardInsetsModule: Module {
  private var observations: [ObjectIdentifier: NSKeyValueObservation] = [:]
  private var notificationTokens: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("KeyboardInsets")

    OnCreate {
      let center = NotificationCenter.default
      for name in [
        UIResponder.keyboardWillShowNotification,
        UIResponder.keyboardDidShowNotification,
        UIResponder.keyboardWillChangeFrameNotification,
        UIResponder.keyboardDidChangeFrameNotification,
        UIResponder.keyboardWillHideNotification,
      ] {
        self.notificationTokens.append(
          center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            self?.enforce()
          }
        )
      }
    }

    OnDestroy {
      self.notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
      self.notificationTokens.removeAll()
      self.observations.removeAll()
    }

    /// Attach to every WKWebView currently in the window hierarchy (called
    /// from JS after a WebView mounts) and zero their insets now.
    Function("enforce") {
      self.enforce()
    }

    /// Diagnostics: every web view's scroll geometry, one line each.
    Function("debug") { () -> String in
      var lines: [String] = ["observed=\(self.observations.count)"]
      for wk in self.allWebViews() {
        let sv = wk.scrollView
        lines.append(
          "b=\(Int(wk.bounds.height)) cs=\(Int(sv.contentSize.height)) off=\(Int(sv.contentOffset.y)) ci=\(Int(sv.contentInset.bottom)) aci=\(Int(sv.adjustedContentInset.bottom)) sa=\(Int(sv.safeAreaInsets.bottom)) wsa=\(Int(wk.safeAreaInsets.bottom)) beh=\(sv.contentInsetAdjustmentBehavior.rawValue) win=\(Int(wk.convert(wk.bounds, to: nil).maxY))"
        )
      }
      return lines.joined(separator: "\n")
    }
  }

  private var applying = false

  /// The keyboard animation runs ~250ms and the WebView's own layout pass
  /// (which resets contentInset) lands somewhere inside it, so the
  /// correction is re-checked at a few points after each notification.
  private func enforce() {
    for delay in [0.0, 0.05, 0.15, 0.3, 0.45, 0.65] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        for webView in self.allWebViews() {
          self.watch(webView.scrollView)
          self.cancelSystemInset(webView.scrollView)
        }
      }
    }
  }

  private func watch(_ scrollView: UIScrollView) {
    let id = ObjectIdentifier(scrollView)
    if observations[id] != nil { return }
    observations[id] = scrollView.observe(\.contentInset, options: [.new]) { [weak self] sv, _ in
      self?.cancelSystemInset(sv)
    }
  }

  private func cancelSystemInset(_ scrollView: UIScrollView) {
    if applying { return }
    applying = true
    defer { applying = false }
    // What the system added on top of contentInset (keyboard); zero with
    // the keyboard away, so this also restores a plain zero inset.
    let system = scrollView.adjustedContentInset.bottom - scrollView.contentInset.bottom
    let wanted = UIEdgeInsets(top: 0, left: 0, bottom: -max(0, system), right: 0)
    if scrollView.contentInset != wanted {
      scrollView.contentInset = wanted
    }
    if scrollView.verticalScrollIndicatorInsets != .zero {
      scrollView.verticalScrollIndicatorInsets = .zero
    }
    // Pull the content back if it was already dragged into the inset.
    let maxY = max(0, scrollView.contentSize.height - scrollView.bounds.height)
    if scrollView.contentOffset.y > maxY + 0.5 {
      scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: maxY), animated: false)
    }
  }

  private func allWebViews() -> [WKWebView] {
    var result: [WKWebView] = []
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes {
      for window in scene.windows {
        collect(window, into: &result)
      }
    }
    return result
  }

  private func collect(_ view: UIView, into result: inout [WKWebView]) {
    if let wk = view as? WKWebView {
      result.append(wk)
      return
    }
    for sub in view.subviews {
      collect(sub, into: &result)
    }
  }
}
