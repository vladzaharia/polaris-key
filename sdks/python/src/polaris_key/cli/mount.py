"""What a mount puts into a host CLI: which verbs, under which words, and what collides with the
host's own commands (the ``mount`` rows of the ``cli`` family in
``conformance/corpus/v2/ui-matrix.json``, plans/UK-51.md; the Node kit's ``cli/mount.ts``).

Pure: the argparse, click and typer adapters call :func:`plan_mount` and register what it returns,
so all three mount the same commands and fail the same way. No framework is imported here.

A *verb id* is what a person types after the program (``activate``, ``devices list``). Python's
table has one verb per first word (``devices`` takes ``list``, ``rename``, ``deauthorize``), so the
ids map onto it: a verb is mounted when any of its ids is, and a verb with only some of its actions
mounted refuses the others (:func:`allowed_actions`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

from . import verbs as _verbs

__all__ = [
    "END_USER",
    "CONFIG_OPTIONS",
    "BOUND_OPTIONS",
    "COLLISION_CODE",
    "VerbCollisionError",
    "MountPlan",
    "plan_mount",
    "select_verbs",
    "skip_warning",
    "report_skipped",
    "check_config",
    "debug_on",
    "BAD_CONFIG_CODE",
    "allowed_actions",
    "Binding",
    "resolve_binding",
    "ID_COPY",
    "ID_ARGS",
    "HELP_ORDER",
    "help_order",
    "id_term",
    "verb_usage",
    "runtime_prog",
    "OPTION_COPY",
    "option_help",
    "default_id",
    "verb_help",
]

#: The default mount: what a person using the host's CLI needs. Developer verbs mount by name.
END_USER: Tuple[str, ...] = (
    "activate",
    "deactivate",
    "devices deauthorize",
    "devices list",
    "devices rename",
    "login",
    "logout",
    "status",
    "update apply",
    "update check",
)

#: The options a host that gives its ``config`` or ``client`` no longer needs (the corpus's three).
CONFIG_OPTIONS: Tuple[str, ...] = ("--base-url", "--product", "--trust")

#: Everything a bound mount hides on each verb: the corpus's three, the services pin, the config
#: directory and the per-verb ``--version`` (the host's version is the one that counts).
BOUND_OPTIONS: Tuple[str, ...] = CONFIG_OPTIONS + ("--config-dir", "--service", "--version")

#: The registration error's code.
COLLISION_CODE = "polaris-verb-collision"

#: The code of a ``config`` the mount cannot build a client from.
BAD_CONFIG_CODE = "polaris-bad-config"

#: Developer ids: mounted only when named.
_DEVELOPER: Tuple[Tuple[str, str], ...] = (
    ("boot", "boot"),
    ("changelog", "changelog"),
    ("config get", "config"),
    ("config list", "config"),
    ("config reset", "config"),
    ("config set", "config"),
    ("doctor", "doctor"),
    ("enroll", "enroll"),
    ("import-bundle", "import-bundle"),
    ("mint", "mint"),
    ("offline-request", "offline-request"),
    ("packs ensure", "packs"),
    ("packs status", "packs"),
    ("register", "register"),
    ("secret", "secret"),
    # Python's own: the corpus lists neither (update download writes a build to disk).
    ("update download", "update"),
)

#: Every verb id, sorted as the corpus lists them, and the verb that runs it.
IDS: Tuple[Tuple[str, str], ...] = tuple(
    sorted(
        (
            ("activate", "activate"),
            ("deactivate", "deactivate"),
            ("devices deauthorize", "devices"),
            ("devices list", "devices"),
            ("devices rename", "devices"),
            ("login", "login"),
            ("logout", "logout"),
            ("status", "status"),
            ("update apply", "update"),
            ("update check", "update"),
        )
        + _DEVELOPER
    )
)

#: A verb's other words: ``sign-in`` is ``login``, ``sign-out`` is ``logout``.
ALIASES: Mapping[str, str] = _verbs.ALIASES_OF

#: The catalog key of each id's one-line description (``cli.verb.*``); an id with none uses its verb's help.
ID_COPY: Mapping[str, str] = {
    "activate": "cli.verb.activate",
    "enroll": "cli.verb.enroll",
    "deactivate": "cli.verb.deactivate",
    "status": "cli.verb.status",
    "offline-request": "cli.verb.offlineRequest",
    "import-bundle": "cli.verb.importBundle",
    "login": "cli.verb.login",
    "logout": "cli.verb.logout",
    "register": "cli.verb.register",
    "devices list": "cli.verb.devicesList",
    "devices rename": "cli.verb.devicesRename",
    "devices deauthorize": "cli.verb.devicesRemove",
    "config get": "cli.verb.configGet",
    "config list": "cli.verb.configList",
    "config set": "cli.verb.configSet",
    "config reset": "cli.verb.configReset",
    "secret": "cli.verb.secret",
    "mint": "cli.verb.mint",
    "update check": "cli.verb.updateCheck",
    "update apply": "cli.verb.updateApply",
    "changelog": "cli.verb.changelog",
    "packs status": "cli.verb.packsStatus",
    "packs ensure": "cli.verb.packsEnsure",
    "doctor": "cli.verb.doctor",
}

#: The arguments of each id, as the Node kit's help writes them.
ID_ARGS: Mapping[str, str] = {
    "activate": "[key]",
    "devices rename": "<deviceId> [label...]",
    "devices deauthorize": "<deviceId>",
    "config get": "<key>",
    "config set": "<key> <value>",
    "config reset": "<key>",
    "secret": "<key>",
    "mint": "<recipeId>",
    "packs ensure": "<packIds...>",
    "import-bundle": "<file>",
}

#: Help order, the Node kit's: task order, not the alphabet.
HELP_ORDER: Tuple[str, ...] = (
    "activate",
    "status",
    "enroll",
    "deactivate",
    "login",
    "logout",
    "register",
    "devices list",
    "devices rename",
    "devices deauthorize",
    "config get",
    "config list",
    "config set",
    "config reset",
    "secret",
    "mint",
    "update check",
    "update apply",
    "update download",
    "changelog",
    "packs status",
    "packs ensure",
    "offline-request",
    "import-bundle",
    "doctor",
    "boot",
)


#: The catalog key of each shared option's description (``cli.option.*``).
OPTION_COPY: Mapping[str, str] = {
    "json": "cli.option.json",
    "no-color": "cli.option.noColor",
    "ascii": "cli.option.ascii",
    "yes": "cli.option.yes",
    "device-code": "cli.option.deviceCode",
    "reveal": "cli.option.reveal",
    "allow-workflow-commands": "cli.option.allowWorkflowCommands",
}


def option_help(opt: Any, hidden: bool = False) -> str:
    """An option's description: the catalog's when it has one, else the table's. An option kept only
    for compatibility (``--no-qr`` on sign-in) or one that is not mounted is hidden."""
    import argparse

    if hidden or opt.help.startswith("Accepted for compatibility"):
        return argparse.SUPPRESS
    key = OPTION_COPY.get(opt.name)
    if key:
        from ..ui.core import Copy

        return Copy("en")(key)
    return opt.help


def default_id(verb: str, ids: Sequence[str]) -> str:
    """The id a verb's list entry describes: its first mounted one in help order."""
    own = [i for i in help_order(ids) if i == verb or i.split(" ", 1)[0] == verb or ALIASES.get(verb) == i]
    return own[0] if own else verb


def verb_help(verb: str, ids: Sequence[str], product: str) -> str:
    """The catalog's one line for a verb's list entry (the same as the grouped help's)."""
    from ..ui.core import Copy

    id_ = default_id(ALIASES.get(verb, verb), ids)
    key = ID_COPY.get(id_)
    if key:
        return Copy("en")(key, product=product)
    return next((v.help for v in _verbs.VERBS if v.name == verb), "")


def help_order(ids: Iterable[str]) -> List[str]:
    """``ids`` in help order."""
    rank = {i: n for n, i in enumerate(HELP_ORDER)}
    return sorted(ids, key=lambda i: (rank.get(i, len(rank)), i))


def id_term(id_: str) -> str:
    """An id with its arguments: ``devices rename <deviceId> [label...]``."""
    args = ID_ARGS.get(id_)
    return f"{id_} {args}" if args else id_


def verb_usage(verb: str, ids: Sequence[str]) -> str:
    """What follows a verb's name in its usage line: its arguments, or its mounted actions."""
    actions = [i.split(" ", 1)[1] for i in help_order(ids) if " " in i and i.split(" ", 1)[0] == verb]
    if actions:
        return "[" + " | ".join(f"{a} {ID_ARGS[f'{verb} {a}']}" if f"{verb} {a}" in ID_ARGS else a for a in actions) + "]"
    return ID_ARGS.get(verb, "")


def program_name() -> str:
    """The program the person ran (``tidewater``, or ``python -m tidewater``), as click names it."""
    import os
    import sys

    try:
        from click.utils import _detect_program_name

        return str(_detect_program_name())
    except Exception:
        return os.path.basename(sys.argv[0]) or "polaris-key"


def runtime_prog(namespace: Optional[str] = None, *, in_verb: bool = False) -> Optional[str]:
    """The command a person typed, read from click's context while a command runs: the root's name,
    then the namespace (inside a verb, the verb's own path without the verb). ``None`` outside click."""
    try:
        import click
    except ImportError:  # pragma: no cover
        return None
    ctx = click.get_current_context(silent=True)
    if ctx is None:
        # typer runs a command with no click context current: the name the shell ran, as click reads it.
        name = program_name()
        return f"{name} {namespace}" if namespace else name
    if in_verb:
        return ctx.command_path.rsplit(" ", 1)[0]
    root = ctx.find_root().info_name or None
    if root is None:
        return None
    return f"{root} {namespace}" if namespace else root


#: What a bare ``devices`` or ``update`` runs.
DEFAULT_ACTION: Mapping[str, str] = {"devices": "list", "update": "check", "config": "list", "packs": "status"}


_collision_class: Any = None


def _collision_error(words: Sequence[str], prog: str) -> Exception:
    """A ``VerbCollisionError``. The class is made on first use: ``PolarisError`` lives in a package
    a host that only registers the verbs does not load."""
    global _collision_class
    if _collision_class is None:
        from ..core.errors import PolarisError

        class VerbCollisionError(PolarisError):
            """The registration failed: a host command equals a verb the mount adds."""

            #: The two options that resolve it.
            fixes = ("namespace", "verbs")

            def __init__(self, words: Sequence[str], prog: str = "mytool") -> None:
                listed = ", ".join(f'"{w}"' for w in words)
                many = len(words) > 1
                super().__init__(
                    COLLISION_CODE,
                    f'{COLLISION_CODE}: {listed} {"are" if many else "is"} already {"commands" if many else "a command"}. '
                    f'Set namespace="license" ({prog} license {words[0]}), leave {"them" if many else "it"} out of verbs, '
                    'or set on_collision="skip".',
                )
                self.words = list(words)

        _collision_class = VerbCollisionError
    return _collision_class(words, prog)


def __getattr__(name: str) -> Any:
    if name == "VerbCollisionError":
        _collision_error(["x"], "x")
        return _collision_class
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


_REGENERATE = "run `pkey sdk --lang python --write` to regenerate it"
_config_class: Any = None


def _config_error(message: str) -> Exception:
    """A ``PolarisConfigError``, made on first use for the reason ``VerbCollisionError`` is."""
    global _config_class
    if _config_class is None:
        from ..core.errors import PolarisError

        class PolarisConfigError(PolarisError, ValueError):
            """The registration failed: the ``config`` cannot build a client."""

            def __init__(self, message: str) -> None:
                super().__init__(BAD_CONFIG_CODE, f"{BAD_CONFIG_CODE}: {message}")

        _config_class = PolarisConfigError
    return _config_class(message)


def check_config(config: Any) -> None:
    """Refuse a ``config`` the CLI cannot work from, at registration, with the command that fixes
    it: no product slug, no pinned keys (so no license could verify), a pin that is a placeholder,
    or a base URL that is not an http(s) origin. Raises ``PolarisConfigError`` (a ``ValueError``)."""
    import re

    def bad(what: str) -> Exception:
        return _config_error(f"{what}; {_REGENERATE}.")

    if not isinstance(config, Mapping):
        raise bad("config is missing, pass your generated polaris_config.CONFIG")
    slug = config.get("product_slug") or config.get("product")
    if not isinstance(slug, str) or not slug:
        raise bad("config has no product_slug")
    trust = config.get("trust")
    if not isinstance(trust, Mapping):
        raise bad(f'config for "{slug}" has no trust')
    if not trust:
        raise bad(f'trust for "{slug}" is empty, so no license could verify')
    for kid, key in trust.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
            raise bad(f'the pinned key "{kid}" for "{slug}" is not a raw Ed25519 public key (43 base64url characters), as a placeholder is')
    base = config.get("base_url")
    if base is not None and not (isinstance(base, str) and re.match(r"^https?://[^/\s]+", base, re.I)):
        raise bad(f'base_url {base!r} for "{slug}" is not an http(s) origin such as https://key.plrs.im')


def debug_on(env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether ``DEBUG`` names polaris (or ``*``): the developer asked to see why a verb failed."""
    import os
    import re

    return bool(re.search(r"(^|[,\s])(polaris|\*)", (env if env is not None else os.environ).get("DEBUG", "")))


@dataclass(frozen=True)
class MountPlan:
    #: The ids to register, in the corpus's order.
    ids: Tuple[str, ...]
    #: The verbs to register (the table's names, aliases included), in the table's order.
    verbs: Tuple[str, ...]
    #: The ids ``on_collision="skip"`` dropped.
    skipped: Tuple[str, ...] = ()
    #: The options to hide once a client or config is given.
    hidden: Tuple[str, ...] = ()
    namespace: Optional[str] = None
    #: Each verb's mounted actions, for a verb with several (``update`` -> ``apply``, ``check``).
    actions: Mapping[str, Tuple[str, ...]] = field(default_factory=dict)


def _verb_names(verb: str) -> Tuple[str, ...]:
    """A verb's words: its own and its aliases'."""
    return (verb,) + tuple(a for a, target in ALIASES.items() if target == verb)


def select_verbs(names: Union[Sequence[str], str, None]) -> List[str]:
    """The ids ``names`` picks, in the corpus's order; a name that matches nothing raises."""
    if names == "all":
        return [i for i, _ in IDS]
    if names is None:
        return [i for i in END_USER]
    given = [names] if isinstance(names, str) else list(names)
    known = [i for i, _ in IDS]

    def matches(id_: str, name: str) -> bool:
        return ALIASES.get(name, name) == id_ or (" " in id_ and id_.split(" ", 1)[0] == name)

    for n in given:
        if not any(matches(i, n) for i, _ in IDS):
            raise ValueError(f'polaris-unknown-verb: "{n}" is not a verb. Verbs: {", ".join(known)}.')
    return [i for i, v in IDS if any(matches(i, n) for n in given)]


def plan_mount(
    host: Iterable[str],
    *,
    namespace: Optional[str] = None,
    verbs: Union[Sequence[str], str, None] = None,
    on_collision: str = "error",
    bound: bool = False,
    prog: str = "mytool",
) -> MountPlan:
    """Decide the mount for a host whose own top-level commands are ``host``. Raises
    :class:`VerbCollisionError` (naming every colliding word, sorted) unless ``on_collision`` is
    ``"skip"``."""
    if on_collision not in ("error", "skip"):
        raise ValueError('on_collision is "error" or "skip".')
    ids = select_verbs(verbs)
    by_verb: Dict[str, str] = dict(IDS)
    taken = set(host)

    def words(id_: str) -> List[str]:
        return [namespace] if namespace is not None else list(_verb_names(by_verb[id_]))

    colliding = sorted({w for i in ids for w in words(i) if w in taken})
    hidden = CONFIG_OPTIONS if bound else ()
    skipped: List[str] = []
    if colliding:
        if on_collision != "skip":
            raise _collision_error(colliding, prog)
        skipped = [i for i in ids if any(w in taken for w in words(i))]
        ids = [i for i in ids if i not in skipped]
    names = {by_verb[i] for i in ids}
    ordered = tuple(v.name for v in _verbs.VERBS if ALIASES.get(v.name, v.name) in names)
    actions: Dict[str, List[str]] = {}
    for i in ids:
        if " " in i:
            first, action = i.split(" ", 1)
            actions.setdefault(by_verb[i], []).append(action)
    # Only a verb with some of its actions mounted refuses the rest.
    every: Dict[str, set] = {}
    for i, v in IDS:
        if " " in i:
            every.setdefault(v, set()).add(i.split(" ", 1)[1])
    return MountPlan(
        ids=tuple(ids),
        verbs=ordered,
        skipped=tuple(sorted(skipped)),
        hidden=tuple(hidden),
        namespace=namespace,
        actions={k: tuple(v) for k, v in actions.items() if set(v) != every[k]},
    )


def skip_warning(skipped: Sequence[str], prog: str) -> str:
    """The one warning for a skipped mount."""
    return f"{prog}: skipped {', '.join(skipped)}; already a command here."


def report_skipped(
    plan: "MountPlan",
    prog: str,
    warn: Optional[Any] = None,
    on_skip: Optional[Any] = None,
    default: Optional[Any] = None,
) -> None:
    """Tell the developer about a skipped mount, as the Node kit does: ``on_skip`` gets the ids, and
    ``warn`` the one line. With no ``warn``, nothing reaches the people using the program unless
    ``DEBUG`` names polaris, which prints it through ``default`` (stderr)."""
    if not plan.skipped:
        return
    if on_skip is not None:
        on_skip(list(plan.skipped))
    sink = warn or (default if debug_on() else None)
    if sink is not None:
        sink(skip_warning(plan.skipped, prog))


def allowed_actions(plan_actions: Mapping[str, Tuple[str, ...]], verb: str, words: Sequence[str]) -> bool:
    """Whether the words a person typed after ``verb`` name a mounted action (a bare verb runs its
    default action)."""
    mounted = plan_actions.get(verb)
    if mounted is None:
        return True
    action = words[0] if words else DEFAULT_ACTION.get(verb, "")
    return action in mounted


@dataclass(frozen=True)
class Binding:
    """How a mount builds its client: the host's own factory or options, or a client/config the host
    gave once so no integration option is needed."""

    factory: Any
    #: The options every verb runs with when bound (product and version fixed); ``None`` unbound.
    options: Optional[Any]
    bound: bool
    #: Whether a verb closes the client it was handed (not one the host owns).
    close: bool
    product: Optional[str] = None


def resolve_binding(
    client_factory: Any = None,
    *,
    client: Any = None,
    config: Optional[Mapping[str, Any]] = None,
    version: Optional[str] = None,
) -> Binding:
    """``client=`` (a ready client the host keeps) or ``config=`` (your generated ``polaris_config.CONFIG``
    with ``version=``) bind the mount; otherwise ``client_factory`` (default: build from the options)."""
    from . import core

    if client is not None and config is not None:
        raise ValueError("polaris-bound-twice: pass client= or config=, not both.")
    if config is not None:
        check_config(config)
    if client is not None:
        product = str(getattr(client, "product", None) or "")
        return Binding(lambda _o: client, core.ClientOptions(product=product), True, False, product or None)
    if config is not None:
        cfg = dict(config)
        product = str(cfg.get("product_slug") or cfg.get("product") or "")
        ver = version or cfg.get("version") or core.DEFAULT_VERSION
        cfg["version"] = ver

        def build(opts: Any) -> Any:
            from ..client import PolarisKeyClient

            extra = {"config_dir": opts.config_dir} if getattr(opts, "config_dir", None) else {}
            return PolarisKeyClient.create(**{**cfg, **extra})

        return Binding(build, core.ClientOptions(product=product, version=str(ver)), True, True, product or None)
    return Binding(client_factory or core.default_client_factory, None, False, True)
