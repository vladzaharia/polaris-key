# Fixture for tools/api-check.test.ts (rule 1, Python).
class FixtureClient:
    def get_value(self, key):
        return key

    def get_config(self, key):
        return key

    @property
    def status(self):
        return "ok"

    async def sync_now(self):
        pass

    def _private(self):
        pass

    def __init__(self):
        pass

    def helper(self):
        def nested():
            pass
        return nested


class Other:
    def not_scanned(self):
        pass
