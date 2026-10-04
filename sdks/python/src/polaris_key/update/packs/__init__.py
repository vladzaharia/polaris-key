"""``polaris_key.update.packs`` — packs (plans/P4-01.md §2.3–§2.10; CONTENT §10, §13; P4-07).

A port of ``@polaris-key/client-core``'s ``packs/`` (the pack-id and object-ref rules, the
``content`` claims, the files index and its path rules, ``tree_digest``, the variant key, the
content stamp, ``pack_set_id``, the window check, the appliers, the chunk index and chunk sync
(P4-11), the planner, variant selection and target mapping, the marker, the install-state machine and the pipeline) and of
``@polaris-key/node``'s host side (the zstd backend, the directory store and the
``client.update.packs`` facet). Names follow the TypeScript ones in snake_case.
"""

from __future__ import annotations

from ...core.pack_claims import content_claims, is_pack_id, object_ref, variant_key
from .apply import ApplyPorts, ApplyResult, apply_delta, apply_file, apply_full
from .boot import boot_pack_options, run_boot_fetch
from .chunk_apply import (
    ApplyChunkPorts,
    ChunkRangeResponse,
    ChunkRun,
    ChunkSeed,
    apply_chunk,
    chunk_range_fetch,
    chunk_runs,
    seed_map,
)
from .chunks import ParseChunkIndexResult, parse_chunk_index, parse_chunk_index_bytes, read_u64
from .dataonly import (
    DATA_ONLY_SCRIPT_MARKERS,
    DATA_ONLY_TEXT_EXTENSIONS,
    data_only_extension,
    data_only_file_refusal,
    data_only_path_refusal,
    data_only_refusal,
    data_only_text_refusal,
)
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
    PackPayload,
    PacksSnapshot,
    StagedObject,
    StagedPack,
)
from .handlers import (
    DEFAULT_MAX_FILE_BYTES,
    DataJsonHandler,
    L10nTableHandler,
    MlModel,
    MlModelCandidate,
    MlModelHandler,
)
from .l10n import L10nMessage, L10nTable, bcp47_canonical, parse_l10n_table
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
from .provides import CONTENT_ID_PATTERN, MAX_PROVIDES, PackProvider, ProvidesFacts, provides_of
from .select import (
    index_readable,
    index_rebuildable,
    plan_target,
    with_feed_deltas,
    select_variant,
    usable_codec,
    variant_usable,
)
from .sets import ParseContentStampResult, pack_set_id, parse_content_stamp, stamp_holds
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
    "DATA_ONLY_SCRIPT_MARKERS",
    "DATA_ONLY_TEXT_EXTENSIONS",
    "data_only_extension",
    "data_only_file_refusal",
    "data_only_path_refusal",
    "data_only_refusal",
    "data_only_text_refusal",
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
    "ApplyChunkPorts",
    "ChunkRangeResponse",
    "ChunkRun",
    "ChunkSeed",
    "apply_chunk",
    "chunk_range_fetch",
    "chunk_runs",
    "seed_map",
    "ParseChunkIndexResult",
    "parse_chunk_index",
    "parse_chunk_index_bytes",
    "read_u64",
    "FILES_TREE_HANDLER",
    "EmbeddedBaseline",
    "InstalledPayload",
    "ObjectResponse",
    "PackEngine",
    "PackError",
    "PackEstimate",
    "PackHandler",
    "PackProgress",
    "PackPayload",
    "PacksSnapshot",
    "StagedObject",
    "StagedPack",
    "DEFAULT_MAX_FILE_BYTES",
    "DataJsonHandler",
    "L10nTableHandler",
    "MlModel",
    "MlModelCandidate",
    "MlModelHandler",
    "L10nMessage",
    "L10nTable",
    "bcp47_canonical",
    "parse_l10n_table",
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
    "with_feed_deltas",
    "select_variant",
    "usable_codec",
    "variant_usable",
    "ParseContentStampResult",
    "pack_set_id",
    "parse_content_stamp",
    "stamp_holds",
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
    "CONTENT_ID_PATTERN",
    "MAX_PROVIDES",
    "PackProvider",
    "ProvidesFacts",
    "provides_of",
]
