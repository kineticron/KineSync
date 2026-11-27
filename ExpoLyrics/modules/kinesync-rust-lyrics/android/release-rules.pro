# JNI resolves these names in the release C++ shim.
-keepclasseswithmembernames,includedescriptorclasses class dev.kineticron.rustlyrics.RustBridge {
  native <methods>;
}
-keepclasseswithmembernames,includedescriptorclasses class dev.kineticron.rustlyrics.FrameSample {
  native <methods>;
}

# Expo derives the native view name and constructor from the view class.
-keep,allowoptimization class dev.kineticron.rustlyrics.KineSyncRustLyricsView {
  public <init>(android.content.Context, expo.modules.kotlin.AppContext);
}

# Release source-set stubs satisfy shared Kotlin call sites at compile time.
# Require R8 to discard them from the APK.
-checkdiscard class dev.kineticron.rustlyrics.FrameObserver
-checkdiscard class dev.kineticron.rustlyrics.FrameSample {
  void emit(...);
}
-checkdiscard class dev.kineticron.rustlyrics.RustOwner {
  *** readOnWorker(...);
}
