{
  "targets": [
    {
      "target_name": "vav_native",
      "sources": [
        "src/addon.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_CFLAGS": ["-Wno-deprecated-declarations"],
        # -Wl,-S: no debug stabs, which would carry the absolute path of the build folder
        "OTHER_LDFLAGS": [
          "-Wl,-S",
          "-framework", "Foundation",
          "-framework", "AppKit",
          "-framework", "ApplicationServices"
        ]
      }
    }
  ]
}
