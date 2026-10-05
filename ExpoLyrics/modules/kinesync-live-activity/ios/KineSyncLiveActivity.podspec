Pod::Spec.new do |s|
  s.name = 'KineSyncLiveActivity'
  s.version = '1.0.0'
  s.summary = 'Local ActivityKit updates for KineSync lyrics'
  s.description = s.summary
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'Kineticron'
  s.homepage = 'https://github.com/Kineticron/KineSync'
  s.source = { :git => 'https://github.com/Kineticron/KineSync.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit'
  s.source_files = '*.swift'
end
