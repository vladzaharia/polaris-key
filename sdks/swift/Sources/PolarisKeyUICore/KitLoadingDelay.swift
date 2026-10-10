// DL7's delayed loading state (packages/ui-core/src/loading.ts): the core waits the window's start,
// so below `ms` a delayed state expects no copy and from `ms` its usual copy.
// The states it applies to are ui-matrix.json `vocabulary.loadingDelay.states`.

import Foundation

public enum KitLoadingDelay {
    /// The window's start (DL7: 250-300 ms).
    public static let ms: Double = 250
}
