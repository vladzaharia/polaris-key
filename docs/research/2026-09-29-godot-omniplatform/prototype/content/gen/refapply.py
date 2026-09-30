"""Generator shim over the Python reference runner."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runners", "python"))
import pkey_content as pc  # noqa: E402
import runcases  # noqa: E402

Store = runcases.Store
run_apply = runcases.run_apply
run_index = runcases.run_index
check_paths = pc.check_paths
