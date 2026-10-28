// The `user` block rules of a catalog entry (S-17 section 5.3 rules 1-5 and the block's shape): a port of
// `userSettingIssues` and `mergeMembersOverLimit` from `packages/shared-catalog/src/cloudSync.ts`, by way of
// the Python `routes.py`. The corpus pins it: `sync-scenarios.json`'s `settingCases`.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_MAX_MERGE_MEMBERS
import im.plrs.key.core.boolValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One problem with a `user` block; only an `error` severity blocks. */
public data class UserSettingIssue(val code: String, val severity: String, val at: String, val message: String)

public object SyncUserSetting {
    private val userBlockMembers = setOf("sync", "conflict", "listed")

    private fun schemaTypeIn(schema: JsonObject, types: List<String>): Boolean = when (val t = schema["type"]) {
        is JsonArray -> t.isNotEmpty() && t.all { it.stringValue in types }
        else -> t.stringValue in types
    }

    /** Rule 5: a `merge` value merges at most [SYNC_MAX_MERGE_MEMBERS] top-level members. */
    public fun mergeMembersOverLimit(schema: JsonObject): Boolean {
        val declared = schema["properties"].objectValue?.size ?: 0
        return (SyncJson.isNumber(schema["maxProperties"]) && numberOver(schema["maxProperties"])) ||
            declared > SYNC_MAX_MERGE_MEMBERS
    }

    private fun numberOver(v: JsonElement?): Boolean = (v as JsonPrimitive).content.toDouble() > SYNC_MAX_MERGE_MEMBERS

    /**
     * Every problem with `entry["user"]` (S-17 section 5.3 rules 1-5 and the block's shape), or empty.
     * Only `severity == "error"` blocks.
     */
    public fun issues(entry: JsonObject): List<UserSettingIssue> = when (val user = entry["user"]) {
        null -> emptyList()

        is JsonObject -> blockIssues(entry, user)

        else -> listOf(
            error(
                "invalid_user_setting",
                "user",
                "user must be an object with optional sync (user, platform or local), conflict and listed.",
            ),
        )
    }

    private fun blockIssues(entry: JsonObject, user: JsonObject): List<UserSettingIssue> {
        val out = mutableListOf<UserSettingIssue>()
        out += shapeIssues(user)
        if (entry["kind"].stringValue != "config") out += error("user_setting_wrong_kind", "user", "user is only valid on config entries.")
        if (entry["managementDefault"].stringValue in SyncRoutes.lockedDefaults) {
            out += UserSettingIssue(
                "user_setting_locked_default",
                "warning",
                "user",
                "user has no effect on a key whose managementDefault is enforced or hidden: the key is locked, so it never syncs.",
            )
        }
        out += conflictIssues(user["conflict"], entry["schema"] as? JsonObject ?: JsonObject(emptyMap()))
        return out
    }

    private fun error(code: String, at: String, message: String) = UserSettingIssue(code, "error", at, message)

    private fun shapeIssues(user: JsonObject): List<UserSettingIssue> {
        val out = mutableListOf<UserSettingIssue>()
        for (member in user.keys) {
            if (member !in userBlockMembers) {
                out += error("invalid_user_setting", "user.$member", "user.$member is not a synced-setting member (sync, conflict, listed).")
            }
        }
        if (user["sync"].stringValue == "device") {
            out += error(
                "invalid_user_setting",
                "user.sync",
                "user.sync device is retired: a reinstall gets a new device id, so the value could not survive it. " +
                    "Use local to keep a value on the device.",
            )
        } else if (user.containsKey("sync") && user["sync"].stringValue !in SyncRoutes.USER_SETTING_SYNC_SCOPES) {
            out += error("invalid_user_setting", "user.sync", "user.sync must be user, platform or local.")
        }
        if (user.containsKey("listed") && user["listed"].boolValue == null) {
            out += error("invalid_user_setting", "user.listed", "user.listed must be a boolean.")
        }
        return out
    }

    private fun conflictIssues(raw: JsonElement?, schema: JsonObject): List<UserSettingIssue> {
        val conflict = raw.stringValue
        val out = mutableListOf<UserSettingIssue>()
        if (conflict == "union") {
            out +=
                error(
                    "user_conflict_union",
                    "user.conflict",
                    "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.",
                )
        } else if (raw != null && conflict !in SyncRoutes.USER_SETTING_CONFLICTS) {
            out += error("invalid_user_setting", "user.conflict", "user.conflict must be lastWrite, max, min or merge.")
        }
        if ((conflict == "max" || conflict == "min") && !schemaTypeIn(schema, listOf("number", "integer"))) {
            out += error("user_conflict_type_mismatch", "user.conflict", "user.conflict $conflict needs a number schema.")
        }
        if (conflict == "merge") {
            if (!schemaTypeIn(schema, listOf("object"))) {
                out +=
                    error(
                        "user_conflict_type_mismatch",
                        "user.conflict",
                        "user.conflict merge needs an object schema; a set is an object of booleans.",
                    )
            } else if (mergeMembersOverLimit(schema)) {
                out += error(
                    "merge_members_over_limit",
                    "schema",
                    "A merged value has at most $SYNC_MAX_MERGE_MEMBERS top-level members (maxProperties and declared properties).",
                )
            }
        }
        return out
    }
}
