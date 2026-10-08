# polaris-key-packs' consumer rules (SP-50). The native zstd decoder is opt-in (polaris-key-zstd):
# :packs links zstd-jni compileOnly, and without it `selectZstd` answers the `dependency` N/A at run
# time, so a minified app that leaves it out must still build.
-dontwarn com.github.luben.zstd.**
