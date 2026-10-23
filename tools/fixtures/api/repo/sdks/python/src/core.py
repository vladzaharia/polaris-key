# Fixture tree for rule 2; not part of any package.
ctx = CoreContext(trust=trust_store)
client = create(trust=dict(PINNED_KEYS))
other = create(trust = {"k": 1})
