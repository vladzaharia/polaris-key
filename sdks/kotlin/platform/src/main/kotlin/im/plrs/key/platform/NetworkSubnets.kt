package im.plrs.key.platform

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

/** The subnets a [Network] is connected to, from its link properties (CC-12b.2). */
public object NetworkSubnets {
    public fun of(context: Context, network: Network): List<Subnet> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return emptyList()
        val props = cm.getLinkProperties(network) ?: return emptyList()
        return props.linkAddresses.map { Subnet(it.address, it.prefixLength) }
    }

    /** True when some subnet holds [host]; an empty list holds nothing. */
    public fun any(subnets: List<Subnet>, host: String): Boolean = subnets.any { it.contains(host) }
}
