// @pkey-feature connect.local ui.kit
// What the paired devices screen's controls do (CC-29K.2). Every member does nothing by default, so a still draws without a state holder.

package im.plrs.key.ui

/** The row being edited: rename, forget and the Can connect switch. */
public interface PolarisPairedRowActions {
    public fun startRename(id: String) {}

    public fun setDraft(text: String) {}

    public fun saveRename() {}

    public fun askForget(id: String) {}

    public fun confirmForget() {}

    public fun cancelEdit() {}

    public fun setReachable(id: String, on: Boolean) {}
}

/** The screen itself: Try again, Done, Pair with a Code, the app's own answer for a device and focus handling. */
public interface PolarisPairedScreenActions {
    public fun retry() {}

    /** Try again on the app's answer for [id] (the busy one): the notice shows busy until the host reports the next answer. */
    public fun retryNotice(id: String) {}

    public fun done() {}

    public fun pair() {}

    public fun focusHandled() {}
}

/** Everything the paired devices screen's controls do. */
public interface PolarisPairedDevicesActions :
    PolarisPairedRowActions,
    PolarisPairedScreenActions {
    /** The controls that do nothing: a still. */
    public object None : PolarisPairedDevicesActions
}
