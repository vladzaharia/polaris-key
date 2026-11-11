// @pkey-feature connect.local ui.kit
// What the paired devices screen's controls do (CC-29K.2): every callback defaults to nothing, so a still draws without a state holder.
@file:Suppress("LongParameterList")

package im.plrs.key.ui

public class PolarisPairedDevicesActions(
    public val retry: () -> Unit = {},
    public val done: () -> Unit = {},
    public val pair: () -> Unit = {},
    public val startRename: (String) -> Unit = {},
    public val setDraft: (String) -> Unit = {},
    public val saveRename: () -> Unit = {},
    public val askForget: (String) -> Unit = {},
    public val confirmForget: () -> Unit = {},
    public val cancelEdit: () -> Unit = {},
    public val setReachable: (String, Boolean) -> Unit = { _, _ -> },
    public val focusHandled: () -> Unit = {},
)
