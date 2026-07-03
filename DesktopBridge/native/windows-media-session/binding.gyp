{
  "targets": [
    {
      "target_name": "windows_media_session",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "sources": ["src/windows_media_session.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["runtimeobject.lib", "windowsapp.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/Zc:__cplusplus", "/std:c++20", "/EHsc"],
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
