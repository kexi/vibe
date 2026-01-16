{
  "targets": [
    {
      "target_name": "vibe_native",
      "sources": ["src/clone.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "defines": ["__DARWIN__"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }],
        ["OS=='linux'", {
          "defines": ["__LINUX__"],
          "cflags": ["-fPIC"],
          "cflags_cc": ["-fPIC"]
        }]
      ]
    }
  ]
}
