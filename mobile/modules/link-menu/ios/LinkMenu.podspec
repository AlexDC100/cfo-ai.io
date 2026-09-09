Pod::Spec.new do |s|
  s.name           = 'LinkMenu'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS context menu (preview + Rename / Delete) for the chat rows inside the WebView.'
  s.description    = 'Wraps each WKWebView UI delegate so a long-press on a chat-row link shows the system context menu with a preview of the row and Rename / Delete actions, and no menu on any other link.'
  s.author         = 'CFO AI'
  s.homepage       = 'https://cfo-ai.io'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = "**/*.{h,m,swift}"
end
