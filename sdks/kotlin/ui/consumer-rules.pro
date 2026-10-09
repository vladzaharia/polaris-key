# polaris-key-ui consumer rules (P6-11).
# PolarisCopy.fromResources maps each field to its string resource by the field's NAME
# (pkey_ui_<snake_case>), so R8 must keep the field names or an app's translations stop applying.
-keepclassmembers class im.plrs.key.ui.PolarisCopy {
    java.lang.String *;
}

# The sign-in ViewModel is created reflectively by ViewModelProvider.
-keepclassmembers class im.plrs.key.ui.PolarisSignInViewModel {
    <init>();
}
