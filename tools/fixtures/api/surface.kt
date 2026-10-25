// Fixture for tools/api-check.test.ts (rule 1, Kotlin).
class FixtureClient {
    fun get(key: String): String = key
    fun getConfig(key: String): String = key
    suspend fun helper() {}
    public fun extra() {}
    val status: String = "ok"
    private fun secret() {}
    internal fun inner() {}
    protected fun guarded() {}
    fun _underscore() {}
    fun withBody() {
        fun nested() {}
        nested()
    }
}

class Other {
    fun notScanned() {}
}
