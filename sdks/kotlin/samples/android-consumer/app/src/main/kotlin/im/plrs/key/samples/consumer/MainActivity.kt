package im.plrs.key.samples.consumer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import im.plrs.key.billing.PolarisPlayBilling
import im.plrs.key.billing.create
import im.plrs.key.ui.PolarisKeyApp

/** The drop-in kit over the app's client, and Play Billing beside it (a direct build never buys). */
class MainActivity : ComponentActivity() {
    private val client get() = (application as ConsumerApp).client

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                PolarisKeyApp(client) { Text("Licensed") }
            }
        }
    }

    /** One-call Play purchases as licence flags. */
    fun billing(): PolarisPlayBilling = PolarisPlayBilling.create(this, client)
}
