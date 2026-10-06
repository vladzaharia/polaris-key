# Legal drafts

**These are first drafts. They have not been reviewed by a lawyer and must not be published or
linked from the product yet.**

| File              | What it is                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| `privacy.md`      | Privacy Policy for end users and console users                                  |
| `terms.md`        | Terms of Service                                                                |
| `help.md`         | Help page: sign-in, codes, Hide My Email, lost keys, devices, deletion, support |
| `REVIEW-NOTES.md` | Every factual claim with the code it came from, open placeholders, and concerns |

They follow the owner's brief: plain language, second person, questions as headings, a short
version at the top, and no vague hedging. Every fact was taken from the code at commit
`9c00cc95f`, not guessed.

Text in `[[OWNER: …]]` marks a fact or decision the owner still has to supply, such as the legal
entity, contact addresses, governing law and minimum age. The full list is in
`REVIEW-NOTES.md` §1.

Before publishing:

1. The owner fills every `[[OWNER: …]]` placeholder.
2. A lawyer reviews all three documents, together with the developer terms and DPA (not yet
   written).
3. Someone re-checks `REVIEW-NOTES.md` §3 against the code at that time, because features
   marked "planned" may have shipped.
4. The pages go somewhere public. Today the `/docs` site is admin-only, so it can't host them.
