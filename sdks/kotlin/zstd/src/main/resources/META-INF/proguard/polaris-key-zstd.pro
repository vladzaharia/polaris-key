# polaris-key-zstd's consumer rules (SP-50). zstd-jni's native library finds its Java classes,
# methods and fields by name, and zstd-jni ships no rules of its own: keep them as they are.
-keep class com.github.luben.zstd.** { *; }
