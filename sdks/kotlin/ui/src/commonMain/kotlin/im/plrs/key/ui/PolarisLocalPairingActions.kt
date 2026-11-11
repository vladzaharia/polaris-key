// @pkey-feature connect.local ui.kit
// What the pairing screen's controls do (CC-29K.2). Every member does nothing by default, so a still draws without a state holder and a
// host or test overrides only what it watches.

package im.plrs.key.ui

/** Moving between the steps of Pair with a Code. */
public interface PolarisPairFlowActions {
    public fun show() {}

    public fun enter() {}

    public fun showNew() {}

    public fun back() {}

    public fun cancel() {}

    public fun close() {}

    public fun done() {}

    public fun retry() {}
}

/** Scan a code: the entry. */
public interface PolarisPairScanActions {
    /** Scan a code: opens the host's scanner (Google's sheet on the Play build). */
    public fun scan() {}
}

/** The forms and the consent of Pair with a Code, and the host's own entries. */
public interface PolarisPairFormActions {
    public fun pair() {}

    public fun confirm() {}

    public fun notNow() {}

    public fun setEntry(text: String) {}

    public fun setName(text: String) {}

    public fun openSettings() {}

    public fun openPairedDevices() {}
}

/** Everything the pairing screen's controls do. */
public interface PolarisLocalPairingActions :
    PolarisPairFlowActions,
    PolarisPairFormActions,
    PolarisPairScanActions {
    /** The controls that do nothing: a still. */
    public object None : PolarisLocalPairingActions
}

/** The entries of Pair with a Code that are the app's own. */
public interface PolarisPairHost {
    /** The platform's settings for this app (the local network answer's Open Settings). */
    public fun openSettings() {}

    /** The app's Paired devices screen. */
    public fun openPairedDevices() {}

    /** Nothing: the host has no such entries. */
    public object None : PolarisPairHost
}
