"""``polaris_key.update.packs`` — packs (plans/P4-01.md §2.3–§2.10; CONTENT §10, §13; P4-07).

A port of ``@polaris-key/client-core``'s ``packs/`` (the pack-id and object-ref rules, the
``content`` claims, the files index and its path rules, ``tree_digest``, the variant key, the
content stamp, ``pack_set_id``, the window check, the appliers, the planner, variant selection and
target mapping, the marker, the install-state machine and the pipeline) and of
``@polaris-key/node``'s host side (the zstd backend, the directory store and the
``client.update.packs`` facet). Names follow the TypeScript ones in snake_case.
"""

from __future__ import annotations

from ...core.pack_claims import content_claims, is_pack_id, object_ref, variant_key
from .apply import ApplyPorts, ApplyResult, apply_delta, apply_file, apply_full
from .boot import boot_pack_options, run_boot_fetch
from .engine import (
    FILES_TREE_HANDLER,
    EmbeddedBaseline,
    InstalledPayload,
    ObjectResponse,
    PackEngine,
    PackError,
    PackEstimate,
    PackHandler,
    PackProgress,
    PacksSnapshot,
    StagedObject,
)
from .files import (
    CheckPathsResult,
    ParseFilesIndexResult,
    check_paths,
    parse_files_index,
    tree_digest,
)
from .marker import VerifyMarkerResult, match_embedded, verify_marker
from .memory import memory_pack_state_store, memory_pack_storage
from .patch import open_object, parse_patch
from .plan import PLAN_STRATEGIES, plan
from .ports import (
    READ_CHUNK,
    InstalledFile,
    hash_source,
    memory_source,
    read_all,
    sha256_of,
    slice_source,
)
from .select import (
    index_readable,
    index_rebuildable,
    plan_target,
    select_variant,
    usable_codec,
    variant_usable,
)
from .sets import ParseContentStampResult, pack_set_id, parse_content_stamp
from .state import (
    PACK_STATE_VERSION,
    abandon_install,
    begin_install,
    checkpoint,
    commit_install,
    confirm_boot,
    empty_pack_state,
    gc_roots,
    parse_pack_state,
    reload_pack_state,
    rollback_install,
    serialize_pack_state,
)
from .window import frame_window, window_allowed, window_log_max

__all__ = [
    "content_claims",
    "is_pack_id",
    "object_ref",
    "variant_key",
    "ApplyPorts",
    "ApplyResult",
    "apply_delta",
    "apply_file",
    "apply_full",
    "boot_pack_options",
    "run_boot_fetch",
    "FILES_TREE_HANDLER",
    "EmbeddedBaseline",
    "InstalledPayload",
    "ObjectResponse",
    "PackEngine",
    "PackError",
    "PackEstimate",
    "PackHandler",
    "PackProgress",
    "PacksSnapshot",
    "StagedObject",
    "CheckPathsResult",
    "ParseFilesIndexResult",
    "check_paths",
    "parse_files_index",
    "tree_digest",
    "VerifyMarkerResult",
    "match_embedded",
    "verify_marker",
    "memory_pack_state_store",
    "memory_pack_storage",
    "open_object",
    "parse_patch",
    "PLAN_STRATEGIES",
    "plan",
    "READ_CHUNK",
    "InstalledFile",
    "hash_source",
    "memory_source",
    "read_all",
    "sha256_of",
    "slice_source",
    "index_readable",
    "index_rebuildable",
    "plan_target",
    "select_variant",
    "usable_codec",
    "variant_usable",
    "ParseContentStampResult",
    "pack_set_id",
    "parse_content_stamp",
    "PACK_STATE_VERSION",
    "abandon_install",
    "begin_install",
    "checkpoint",
    "commit_install",
    "confirm_boot",
    "empty_pack_state",
    "gc_roots",
    "parse_pack_state",
    "reload_pack_state",
    "rollback_install",
    "serialize_pack_state",
    "frame_window",
    "window_allowed",
    "window_log_max",
]
