package im.plrs.key.platform

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import java.net.InetAddress

/** One connected subnet of a network: [address] with a [prefix] length. */
public class Subnet(address: InetAddress, public val prefix: Int) {
    private val bytes: ByteArray = address.address

    /** True when the numeric literal [host] (a `%zone` is ignored) lies in this subnet. */
    public fun contains(host: String): Boolean {
        val literal = host.substringBefore('%')
        if (literal.isEmpty() || !literal.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == '.' || it == ':' }) return false
        val other = runCatching { InetAddress.getByName(literal).address }.getOrNull() ?: return false
        if (other.size != bytes.size) return false
        val full = prefix / 8
        for (i in 0 until full) if (other[i] != bytes[i]) return false
        val rest = prefix % 8
        if (rest == 0) return true
        val mask = (0xFF shl (8 - rest)) and 0xFF
        return (other[full].toInt() and mask) == (bytes[full].toInt() and mask)
    }

    override fun toString(): String = "Subnet(/$prefix)"
}

/**
 * The subnets a [Network] is connected to, from its link properties (CC-12b.2). Reading them needs
 * ACCESS_NETWORK_STATE, which this library does not declare (the app decides): without it the answer is
 * no subnets, and no subnet holds any host, so no address is dialled.
 */
public object NetworkSubnets {
    // ACCESS_NETWORK_STATE is the app's to declare (no permission in the AAR); a refusal is caught below. Lint cannot see
    // that for a normal permission.
    @SuppressLint("MissingPermission")
    @Suppress("SwallowedException")
    public fun of(context: Context, network: Network): List<Subnet> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return emptyList()
        val props = try {
            cm.getLinkProperties(network)
        } catch (e: SecurityException) {
            // The app did not declare ACCESS_NETWORK_STATE.
            null
        } ?: return emptyList()
        return props.linkAddresses.map { Subnet(it.address, it.prefixLength) }
    }

    /** True when some subnet holds [host]; an empty list holds nothing. */
    public fun any(subnets: List<Subnet>, host: String): Boolean = subnets.any { it.contains(host) }
}
