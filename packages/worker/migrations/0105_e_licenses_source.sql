-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2): where a licence minted from a sale came from: a
-- store base purchase (`app-store`, `play`, `steam`) or Polaris Key's own checkout
-- (`polaris-key`, S-21 D9; nothing writes it before CM-05). NULL for every licence today, whose
-- provenance stays `origin` (admin, oidc, enroll).
--
-- ONE statement per file (R11-04).
ALTER TABLE licenses ADD COLUMN source TEXT;
