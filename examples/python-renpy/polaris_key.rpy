# Polaris Key in a Ren'Py game: boot at start-up and gate the main menu.
#
# Vendor the SDK and its dependencies into game/python-packages/ (Ren'Py's documented route for
# third-party packages), for example:
#   pip install --target game/python-packages "polaris-key[keyring]"
# Replace PRODUCT, VERSION and TRUST with your product's values.

init python:
    import polaris_key

    PKEY_PRODUCT = "mygame"
    PKEY_TRUST = {"<your-signing-key-id>": "<your-product-signing-key-b64url>"}

    pkey = polaris_key.create(product_slug=PKEY_PRODUCT, version=config.version, pinned_keys=PKEY_TRUST)

    def pkey_boot():
        """Run the one-call boot; offline or in grace the game still starts."""
        try:
            return pkey.boot()
        except Exception:
            return None

    def pkey_sign_in():
        """Sign in over the device code: open the page, then wait (call it off the UI thread)."""
        session = pkey.identity.sign_in.start()
        session.reopen()
        return session.wait()

label splashscreen:
    $ pkey_outcome = pkey_boot()
    if pkey_outcome is not None and pkey_outcome.needs_activation:
        call screen pkey_activate
    return

screen pkey_activate():
    modal True
    frame:
        xalign 0.5 yalign 0.5
        vbox:
            spacing 12
            text "Activate [PKEY_PRODUCT]"
            textbutton "Sign in with your browser" action Function(renpy.invoke_in_thread, pkey_sign_in)
            textbutton "Continue" action Return()
