// @pkey-feature connect.local ui.kit
// What the pairing screen's controls do (CC-29K.2): every callback defaults to nothing, so a still draws without a state holder.
@file:Suppress("LongParameterList")

package im.plrs.key.ui

public class PolarisLocalPairingActions(
    public val show: () -> Unit = {},
    public val enter: () -> Unit = {},
    public val showNew: () -> Unit = {},
    public val toShow: () -> Unit = {},
    public val toEnter: () -> Unit = {},
    public val back: () -> Unit = {},
    public val cancel: () -> Unit = {},
    public val close: () -> Unit = {},
    public val pair: () -> Unit = {},
    public val confirm: () -> Unit = {},
    public val notNow: () -> Unit = {},
    public val done: () -> Unit = {},
    public val retry: () -> Unit = {},
    public val openSettings: () -> Unit = {},
    public val openPairedDevices: () -> Unit = {},
    public val setEntry: (String) -> Unit = {},
    public val setName: (String) -> Unit = {},
)
