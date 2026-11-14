Pod::Spec.new do |s|
  s.name = 'KineSyncRustLyrics'
  s.version = '0.1.0'
  s.summary = 'Experimental shared Rust lyric renderer'
  s.description = s.summary
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'Kineticron'
  s.homepage = 'https://github.com/kineticron/KineSync'
  s.source = { :git => 'https://github.com/kineticron/KineSync.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Metal', 'QuartzCore', 'CoreText', 'CoreGraphics', 'CoreFoundation', 'Foundation', 'Security', 'SystemConfiguration'
  s.libraries = 'c++', 'z', 'iconv'
  s.source_files = '*.swift'
  # Produced by the reviewed device-only CI step BEFORE prebuild/pod install.
  s.vendored_frameworks = 'Frameworks/KineSyncLyrics.xcframework'
  s.pod_target_xcconfig = { 'OTHER_LDFLAGS' => '$(inherited) -Wl,-u,_kr_abi_version' }
end
