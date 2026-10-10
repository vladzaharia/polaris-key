// @pkey-feature core.errors
//
// Every error code this SDK raises is in the shared registry (conformance/parity/errors.json,
// generated into Constants.generated.kt by `pnpm gen constants`). :core names codes through the
// generated `ErrorCode` constants, which the compiler checks; this test also scans the sources for
// a string literal handed to `PolarisException(` and refuses one the registry lacks, so a code
// cannot bypass the constants.

package im.plrs.key.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorCodeRegistryTest {
    private val raised = Regex("""\bPolarisException\(\s*(?:code\s*=\s*)?"([a-z][a-z0-9_-]*)"""")

    private fun sources(): List<File> =
        File(System.getProperty("pkey.sourceRoot")).walkTopDown()
            .filter { it.isFile && it.extension == "kt" && !it.name.contains(".generated.") }
            .toList()

    @Test
    fun noSourceRaisesAnUnregisteredLiteral() {
        val files = sources()
        assertTrue(files.size > 10)
        val unknown = files.flatMap { f -> raised.findAll(f.readText()).map { it.groupValues[1] }.filter { it !in ERROR_CODE_VALUES }.map { "${f.name}: $it" } }
        assertEquals(emptyList<String>(), unknown)
    }

    @Test
    fun theClientCodesCoreRaisesAreRegisteredAsClientCodes() {
        val raisedByCore = listOf(
            ErrorCode.insecureBaseUrl, ErrorCode.localOnly, ErrorCode.serviceUnavailable, ErrorCode.unsupported,
            ErrorCode.transport, ErrorCode.networkError, ErrorCode.tooManyRedirects, ErrorCode.insecureRedirect,
            ErrorCode.syncFailed, ErrorCode.fetchFailed,
        ) + BundleRefusalReason.entries.map { it.code }
        for (code in raisedByCore) assertEquals(code, "client", ERROR_CODE_KINDS[code])
    }

    @Test
    fun theGeneratedModuleIsConsistent() {
        assertEquals(ERROR_CODE_VALUES.toSet(), ERROR_CODE_KINDS.keys)
        assertEquals(ERROR_CODE_VALUES.size, ERROR_CODE_VALUES.toSet().size)
        assertEquals(SdkId.kotlin, POLARIS_SDK_NAME)
        assertTrue(POLARIS_SDK_NAME in SDK_ID_VALUES)
    }
}
