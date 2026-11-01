package im.plrs.key.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Receives the browser's redirect to the app's registered scheme or claimed link (the Custom Tab path, and the
 * Auth Tab's fallback). Declared not exported with no intent filter; the app adds the filter it registered (see the
 * library manifest). It reads one VIEW intent, passes the URL to the waiting sign-in, brings the app's own activity
 * to the front (closing the tab above it) and finishes. An intent that is not a VIEW of a registered redirect is
 * dropped.
 */
public class PKeyRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(received: Intent?) {
        val url = if (received?.action == Intent.ACTION_VIEW) received.dataString else null
        // The intent is spent: a re-created activity must not deliver the same URL again.
        setIntent(Intent())
        val delivered = RedirectInbox.deliver(url)
        val host = RedirectInbox.hostActivity()
        if (delivered && host != null) {
            startActivity(Intent(this, host).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}
