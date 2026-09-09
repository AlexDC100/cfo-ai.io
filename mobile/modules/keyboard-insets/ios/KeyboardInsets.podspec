Pod::Spec.new do |s|
  s.name           = 'KeyboardInsets'
  s.version        = '1.0.0'
  s.summary        = 'Keeps WKWebView from adding its own keyboard content inset.'
  s.description    = 'The shell shrinks the WebView above the keyboard (KeyboardAvoidingView); WKWebView also insets its scroll view by the keyboard height, which let the page scroll a keyboard height past its content and left fixed elements behind.'
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
