Pod::Spec.new do |s|
  s.name = 'KineSyncActivityTypes'
  s.version = '1.0.0'
  s.summary = 'Shared ActivityKit identity for the lyrics host and widget'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Kineticron'
  s.homepage = 'https://github.com/Kineticron/KineSync'
  s.source = { :git => 'https://github.com/Kineticron/KineSync.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.0'
  s.static_framework = true
  s.frameworks = 'ActivityKit'
  s.source_files = 'LyricsActivityAttributes.swift'
  s.pod_target_xcconfig = { 'APPLICATION_EXTENSION_API_ONLY' => 'YES' }
end
