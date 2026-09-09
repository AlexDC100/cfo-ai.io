// LinkMenu — the system context menu on the drawer's chat rows (2026-09-10
// per operator: "use the native iOS one").
//
// The rows live in the web page, so nothing native can be attached to them
// directly — but WebKit itself runs a long-press recognizer on links and
// asks its UI delegate for a UIContextMenuConfiguration. This module wraps
// each WKWebView's UI delegate (react-native-webview's own) in a proxy that
// forwards everything and answers only that question: a chat-row link
// (/chat?c=<id>&t=<title>) gets a preview of the row plus Rename / Delete;
// any other link gets nil, i.e. no menu and no preview at all.
//
// Chosen actions are dispatched back to the page as `cfo:native-action`
// events; tapping the preview ("commit") opens the chat the same way.

import ExpoModulesCore
import WebKit

public class LinkMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkMenu")

    Function("install") { (rename: String, remove: String, dark: Bool) in
      DispatchQueue.main.async {
        LinkMenuInstaller.shared.install(rename: rename, remove: remove, dark: dark)
      }
    }
  }
}

final class LinkMenuInstaller {
  static let shared = LinkMenuInstaller()
  // WKWebView.uiDelegate is weak — the proxies must be owned here.
  private var proxies: [ObjectIdentifier: LinkMenuDelegateProxy] = [:]

  func install(rename: String, remove: String, dark: Bool) {
    for webView in allWebViews() {
      let key = ObjectIdentifier(webView)
      if let existing = proxies[key] {
        existing.update(rename: rename, remove: remove, dark: dark)
        continue
      }
      let proxy = LinkMenuDelegateProxy(original: webView.uiDelegate, rename: rename, remove: remove, dark: dark)
      proxies[key] = proxy
      webView.uiDelegate = proxy
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

/// Forwards every WKUIDelegate call to the original delegate and implements
/// the two context-menu callbacks itself.
final class LinkMenuDelegateProxy: NSObject, WKUIDelegate {
  private weak var original: WKUIDelegate?
  private var rename: String
  private var remove: String
  private var dark: Bool

  init(original: WKUIDelegate?, rename: String, remove: String, dark: Bool) {
    self.original = original
    self.rename = rename
    self.remove = remove
    self.dark = dark
  }

  func update(rename: String, remove: String, dark: Bool) {
    self.rename = rename
    self.remove = remove
    self.dark = dark
  }

  // ── Forwarding ──────────────────────────────────────────────────
  override func responds(to aSelector: Selector!) -> Bool {
    if super.responds(to: aSelector) { return true }
    return original?.responds(to: aSelector) ?? false
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    if let original, original.responds(to: aSelector) { return original }
    return super.forwardingTarget(for: aSelector)
  }

  // ── The chat-row menu ───────────────────────────────────────────
  private struct ChatRow {
    let id: String
    let title: String
  }

  private func chatRow(from url: URL?) -> ChatRow? {
    guard let url, url.path.hasSuffix("/chat"),
          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
          let id = items.first(where: { $0.name == "c" })?.value, !id.isEmpty
    else { return nil }
    let title = items.first(where: { $0.name == "t" })?.value ?? ""
    return ChatRow(id: id, title: title)
  }

  private func dispatch(_ webView: WKWebView, action: String, id: String) {
    let payload: [String: Any] = ["action": action, "id": id]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('cfo:native-action', { detail: \(json) })); true;")
  }

  func webView(
    _ webView: WKWebView,
    contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
    completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
  ) {
    guard let row = chatRow(from: elementInfo.linkURL) else {
      // Not a chat row: no menu, no preview.
      completionHandler(nil)
      return
    }
    let dark = self.dark
    let width = min(webView.bounds.width - 40, 320)
    let config = UIContextMenuConfiguration(
      identifier: row.id as NSString,
      previewProvider: { ChatRowPreviewController(title: row.title, dark: dark, width: width) },
      actionProvider: { [weak self, weak webView] _ in
        guard let self else { return nil }
        let renameAction = UIAction(title: self.rename, image: UIImage(systemName: "pencil")) { _ in
          if let webView { self.dispatch(webView, action: "chat-rename", id: row.id) }
        }
        let deleteAction = UIAction(title: self.remove, image: UIImage(systemName: "trash"), attributes: .destructive) { _ in
          if let webView { self.dispatch(webView, action: "chat-delete", id: row.id) }
        }
        return UIMenu(title: "", children: [renameAction, deleteAction])
      }
    )
    completionHandler(config)
  }

  // A tap on the preview opens the chat in place (the default would
  // navigate the whole page to the link).
  func webView(
    _ webView: WKWebView,
    contextMenuForElement elementInfo: WKContextMenuElementInfo,
    willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating
  ) {
    animator.preferredCommitStyle = .dismiss
    guard let row = chatRow(from: elementInfo.linkURL) else { return }
    animator.addCompletion { [weak self, weak webView] in
      if let self, let webView { self.dispatch(webView, action: "chat-open", id: row.id) }
    }
  }
}

/// The lifted row: the chat's title on a rounded card in the page's theme.
final class ChatRowPreviewController: UIViewController {
  private let title_: String
  private let dark: Bool
  private let width: CGFloat

  init(title: String, dark: Bool, width: CGFloat) {
    self.title_ = title
    self.dark = dark
    self.width = width
    super.init(nibName: nil, bundle: nil)
    preferredContentSize = CGSize(width: width, height: 48)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = dark ? UIColor(red: 0.063, green: 0.094, blue: 0.086, alpha: 1) : UIColor.white
    let label = UILabel()
    label.text = title_
    label.font = UIFont.systemFont(ofSize: 15, weight: .medium)
    label.textColor = dark ? UIColor(red: 0.91, green: 0.945, blue: 0.933, alpha: 1) : UIColor(red: 0.043, green: 0.07, blue: 0.125, alpha: 1)
    label.lineBreakMode = .byTruncatingTail
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }
}
